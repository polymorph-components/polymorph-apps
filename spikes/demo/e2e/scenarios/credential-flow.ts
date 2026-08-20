// The credential path, against a real S3: escrow, release, use, revoke.
//
// This is the scenario with something to lose. The claim chain is:
//
//   1. A config written before #11 still carries a READABLE secret. Boot
//      migrates it: the secret becomes a non-extractable WebCrypto handle
//      in IndexedDB and is SCRUBBED from localStorage. Afterwards there is
//      no readable copy of it anywhere on the machine.
//   2. The visor can then USE it without ever seeing it again — the sheet
//      offers "leave blank to keep it", because a placeholder is
//      literally the only thing the visor can render for a key it holds.
//   3. The arming delay is real: a Confirm click before it elapses lands
//      on a disabled button and does nothing (the defence against an app
//      training rapid taps where a visor control is about to appear).
//   4. The store actually works, revocation actually darkens it, and a
//      reload re-arms from the persisted handle with no ceremony at all.
//
// Every one of these was previously a hand-drive. (4) in particular is
// the one nobody re-checks, because it looks like nothing happening.

import type { Ctx, Scenario } from "../run.ts";
import {
  act,
  assert,
  assertEquals,
  assertIncludes,
  hook,
  KEYS,
  sheetText,
  sleep,
  UI_TIMEOUT,
  waitForBoot,
  recordStorageWrites,
  waitForPaneStatus,
  waitForPanelSurface,
  waitForSheet,
} from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

const BUCKET = "pm-demo";

/** Wait until the visor has a working bucket: the controls it gates on
 * `bucketReady` come alive. DOM state as the clock, not a sleep. */
async function waitForBucketReady(page: Page, timeout = 120_000): Promise<void> {
  await page.waitForFunction(
    () => (document.getElementById("bucket-sync") as HTMLButtonElement)?.disabled === false,
    undefined,
    { timeout },
  ).catch(async (e) => {
    const status = await page.evaluate(() =>
      document.getElementById("tablet-status")?.textContent ?? ""
    );
    throw new Error(`waiting for the bucket to be ready: tablet said ${JSON.stringify(status)} (${e.message})`);
  });
}

/** Read the escrowed record straight out of IndexedDB, in the page. The
 * point is to inspect the CryptoKey's own flags: a handle that reports
 * `extractable: false` and `usages: ["sign"]` cannot be read back by
 * anything, including the code that stored it. */
function keystoreRecord(page: Page): Promise<
  { origin: string; accessKey: string; extractable: boolean; usages: string[]; type: string } | null
> {
  return page.evaluate(() =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open("pm-demo-keystore");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("sigv4")) return resolve(null);
        const all = db.transaction("sigv4", "readonly").objectStore("sigv4").getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = () => {
          const rec = all.result[0];
          if (!rec) return resolve(null);
          resolve({
            origin: rec.origin,
            accessKey: rec.accessKey,
            extractable: rec.key.extractable,
            usages: rec.key.usages,
            type: rec.key.type,
          });
        };
      };
    })
  ) as Promise<
    { origin: string; accessKey: string; extractable: boolean; usages: string[]; type: string } | null
  >;
}

/** The stored config as a plain object, for checking what is NOT in it. */
function storedConfig(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key: string) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }, KEYS.storage);
}

const scenario: Scenario = {
  name: "credential-flow",
  why: "a legacy secret is escrowed and scrubbed at boot, used without being seen, revoked, and re-armed silently on reload",
  minio: "up",
  // A config in the shape #11 replaced: addressing PLUS a readable
  // secret. Seeded under today's key so `loadStorage` takes the
  // migration branch (`splitLegacyS3`).
  page: (ctx: Ctx) => ({
    storage: {
      [KEYS.storage]: JSON.stringify({
        provider: "s3",
        endpoint: ctx.minioUrl,
        bucket: BUCKET,
        access: ctx.minioAccess,
        // The value the whole migration exists to get rid of.
        secret: ctx.minioSecret,
      }),
    },
  }),

  async run(page, ctx) {
    await act("boot SCRUBBED the readable secret from localStorage", async () => {
      const cfg = await storedConfig(page);
      assert(cfg !== null, "the stored config vanished entirely");
      assertEquals(cfg!.secret, undefined, "the secret field after migration");
      // The addressing survives — it was never the secret part.
      assertEquals(cfg!.endpoint, ctx.minioUrl, "the stored endpoint");
      assertEquals(cfg!.bucket, BUCKET, "the stored bucket");
      assertEquals(cfg!.access, ctx.minioAccess, "the stored access key (public half)");
      // And nothing else in localStorage kept a copy.
      const anywhere = await page.evaluate((needle: string) => {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)!;
          if ((localStorage.getItem(k) ?? "").includes(needle)) return k;
        }
        return null;
      }, ctx.minioSecret);
      // The access key and the secret are the same word in this fixture
      // ("minioadmin"), so a hit on the config key is the PUBLIC half and
      // is expected; a hit anywhere else is not.
      assert(
        anywhere === null || anywhere === KEYS.storage,
        `the secret survived in localStorage under ${anywhere}`,
      );
    });

    await act("the escrowed key is a non-extractable signing handle", async () => {
      const rec = await keystoreRecord(page);
      assert(rec !== null, "no keystore record was written by the migration");
      assertEquals(rec!.origin, new URL(ctx.minioUrl).origin, "the record's bound origin");
      assertEquals(rec!.accessKey, ctx.minioAccess, "the record's public identifier");
      // THE GUARANTEE, and it is the platform's rather than ours:
      // `crypto.subtle.exportKey` on this handle throws by construction.
      assertEquals(rec!.extractable, false, "the escrowed key's extractable flag");
      assertEquals(rec!.usages.join(","), "sign", "the escrowed key's usages");
      assertEquals(rec!.type, "secret", "the escrowed key's type");
    });

    await act("exporting the escrowed key is impossible, not merely unimplemented", async () => {
      // Checked from the page's own realm, which is the realm an attacker
      // would have: the refusal is WebCrypto's, so there is no code path
      // to add that would change it.
      const outcome = await page.evaluate(() =>
        new Promise<string>((resolve) => {
          const req = indexedDB.open("pm-demo-keystore");
          req.onsuccess = () => {
            const all = req.result.transaction("sigv4", "readonly").objectStore("sigv4").getAll();
            all.onsuccess = async () => {
              try {
                await crypto.subtle.exportKey("raw", all.result[0].key);
                resolve("EXPORTED");
              } catch (e) {
                resolve(`refused: ${(e as Error).name}`);
              }
            };
          };
        })
      );
      assert(
        outcome.startsWith("refused:"),
        `the escrowed key was exportable: ${outcome}`,
      );
    });

    await act("boot armed the bucket from the escrowed handle ALONE", async () => {
      // No sheet, no typing: the visor found a handle for this destination
      // and used it. This is asserted BEFORE the Save/Confirm beats
      // below, because otherwise those would be measuring a bucket that
      // was already up — and it also parks the in-flight setup guard,
      // which refuses a second setup while one is running.
      await waitForBucketReady(page);
      assertEquals(
        // deno-lint-ignore no-explicit-any
        await page.evaluate(() => (globalThis as any).__demo.drawer.open()),
        false,
        "a credential sheet during a handle-armed boot",
      );
    });

    await act("the visor's Save leads to a sheet offering the HELD key, not a field", async () => {
      await hook(page, "openStorage");
      await page.waitForFunction(
        () => (document.getElementById("storage-dialog") as HTMLDialogElement)?.open === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      // The panel needs to have mounted and seeded itself from the
      // (secret-free) stored config before the visor can ask it to commit.
      await waitForPanelSurface(page);
      await page.click("#storage-save");
      await waitForSheet(page, "drawer", true, 30_000);
      // ORDERING IS THE INVARIANT: by the time a secret is on screen
      // there is no component surface alive on the page at all.
      const dialogOpen = await page.evaluate(() =>
        (document.getElementById("storage-dialog") as HTMLDialogElement).open
      );
      assertEquals(dialogOpen, false, "the storage dialog while the credential sheet is up");
      const placeholder = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#visor-drawer-inner input")).map((i) =>
          (i as HTMLInputElement).placeholder
        )
      );
      assert(
        placeholder.some((p) => p.includes("non-extractable signing key")),
        `no held-key placeholder on the sheet: ${JSON.stringify(placeholder)}`,
      );
      assert(
        placeholder.some((p) => p.includes("leave blank to keep it")),
        `the sheet did not offer to keep the held key: ${JSON.stringify(placeholder)}`,
      );
      // The visor never spells the word for the thing it is asking for.
      const text = await sheetText(page);
      assert(
        !/password/i.test(text),
        "the credential sheet rendered the word 'password'",
      );
    });

    await act("a Confirm during the arming delay is a NO-OP", async () => {
      // The click is real (the hook clicks the button, it does not call
      // the handler), so an armed-too-early button would show up here as
      // the sheet closing. ARM_MS is 700ms; this lands well inside it.
      await hook(page, "drawer.confirm");
      const stillOpen = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.drawer.open()
      );
      assertEquals(stillOpen, true, "the credential sheet after an early Confirm");
      const disabled = await page.evaluate(() =>
        (document.querySelector("#visor-drawer-inner .cred-row button:first-child") as
          | HTMLButtonElement
          | null)?.disabled ?? null
      );
      assertEquals(disabled, true, "the Confirm button during the arming delay");
    });

    await act("after arming, Confirm commits — and refuses to silently reconfigure", async () => {
      // Installed BEFORE the click. The durable write is the observable
      // here, not the status line: the visor's "storage changed — reload the
      // page to reconfigure" is a NON-STICKY status, and the tablet is
      // still holding a sticky one from its cold pull, so that sentence
      // is legitimately suppressed (host/demo.ts:1132).
      const writes = await recordStorageWrites(page);
      // Wait for the button to ARM — the DOM is the clock again; the
      // early-click above was the thing under test, this is not.
      await page.waitForFunction(
        () =>
          (document.querySelector("#visor-drawer-inner .cred-row button:first-child") as
            | HTMLButtonElement
            | null)?.disabled === false,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await hook(page, "drawer.confirm");
      await waitForSheet(page, "drawer", false, 30_000);
      // CONTRACT (host/demo.ts `persistAndConnect`): with a bucket
      // already live, a commit PERSISTS and then stops — re-running a
      // 20-step setup underneath a working store would re-mint container
      // links and republish pickup objects beneath the first one, so
      // the visor asks for a reload instead of doing it quietly. The
      // "Confirm connects" half of this claim is the boot-arming act
      // above; this is the same commit path arriving at an already-armed
      // store, which is the state a user is actually in here.
      // persistAndConnect's first act is the durable write; seeing it is
      // seeing the commit reach the end of the release path.
      const committed = (await writes()).filter((w) => w.key === KEYS.storage);
      assert(
        committed.length > 0,
        "Confirm never persisted a config — the release path did not complete",
      );
      // AND WHAT IT WROTE IS SECRET-FREE. The S3 secret goes into the
      // keystore as a handle and never becomes part of a config object,
      // in memory or in storage (host/demo.ts, `withCredentials`).
      for (const w of committed) {
        const written = JSON.parse(w.value) as Record<string, unknown>;
        assertEquals(written.secret, undefined, "a persisted config carried a readable secret");
        assertEquals(written.endpoint, ctx.minioUrl, "the persisted endpoint");
      }
      const cfg = await storedConfig(page);
      assertEquals(cfg!.secret, undefined, "the stored config after a commit");
      // The held key is untouched: a blank field meant "keep it".
      const rec = await keystoreRecord(page);
      assertEquals(rec?.extractable, false, "the escrowed key after a commit");
      // And the bucket that was up is still up: nothing was torn down.
      await waitForBucketReady(page);
    });

    await act("the bucket leg really works: alice flushes, the tablet pulls", async () => {
      await page.click("#bucket-sync");
      const status = await waitForPaneStatus(
        page,
        "tablet",
        (t) => t.includes("bucket") || /pull|ops|epoch|up to date/i.test(t),
        "the tablet's bucket pull",
        60_000,
      );
      assert(
        !/failed|error|refused/i.test(status),
        `the tablet's bucket pull reported a failure: ${JSON.stringify(status)}`,
      );
    });

    await act("Bob can pull from the bucket while he is a member", async () => {
      await hook(page, "bobPull");
      const status = await waitForPaneStatus(
        page,
        "bob",
        (t) => t.startsWith("bucket:"),
        "Bob's bucket pull",
        60_000,
      );
      assert(
        !status.includes("kp missing"),
        `Bob was already dark before the revocation: ${JSON.stringify(status)}`,
      );
    });

    await act("after revocation Bob's pull is refused with 'kp missing (404)'", async () => {
      await page.click("#revoke-bob");
      await waitForPaneStatus(
        page,
        "alice",
        (t) => t.includes("revoke:"),
        "alice's revocation note",
        60_000,
      );
      await hook(page, "bobPull");
      // The cooperative-now darkness the S3 provider gives: his K_p is
      // gone, so the epoch key he would need is a 404.
      const status = await waitForPaneStatus(
        page,
        "bob",
        (t) => t.includes("kp missing"),
        "Bob's refusal after revocation",
        60_000,
      );
      assertIncludes(status, "kp missing (404)", "Bob's refusal");
    });

    await act("a reload re-arms from the persisted handle, with no ceremony", async () => {
      // The beat nobody re-checks by hand, because a success looks like
      // nothing happening: no dialog, no sheet, no typing — the visor finds
      // the handle, and the bucket comes back by itself.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page);
      await waitForBucketReady(page);
      assertEquals(await page.evaluate(() =>
        (document.getElementById("storage-dialog") as HTMLDialogElement).open
      ), false, "the storage dialog after a silent re-arm");
      assertEquals(
        // deno-lint-ignore no-explicit-any
        await page.evaluate(() => (globalThis as any).__demo.drawer.open()),
        false,
        "the credential sheet after a silent re-arm",
      );
      const cfg = await storedConfig(page);
      assertEquals(cfg!.secret, undefined, "the stored config after a reload");
      const rec = await keystoreRecord(page);
      assertEquals(rec?.extractable, false, "the escrowed key after a reload");
      await sleep(0);
    });
  },
};

export default scenario;
