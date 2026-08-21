// The erase ceremony, end to end: "this device leaves your account".
//
// SEMANTICS RULING (dispatch authority for this track): reset erases
// every local copy on THIS DEVICE — including the signing keystore, so
// the device can no longer act on the account — and is NOT an
// account-wide erase; other paired devices keep their own copies. This
// scenario is the one place that promise is checked end to end: it seeds
// a name, a petname and a storage config, walks the full ceremony
// (arming delay, wrong-word refusal, correct-word confirm, reload), and
// then asserts every demo-owned key AND the signing keystore are gone —
// followed by a second pass through the ceremony on the now-unnamed
// identity, to prove the fixed-word ("erase") fallback path.

import type { Scenario } from "../run.ts";
import {
  act,
  appSurface,
  assert,
  assertEquals,
  assertIncludes,
  hook,
  identity,
  KEYS,
  sheetText,
  stripText,
  UI_TIMEOUT,
  waitForBoot,
  waitForSheet,
} from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

const PETNAME = "tasks board";
const APP_NOMINATION = "\u265C"; // ♜ — same nomination petname-ceremony.ts adopts

/** The demo's own storage-config key, for the sentinel this scenario
 * seeds. `STORAGE_KEY` is not among the three the visor's own erase
 * wipes (identity/hue/marks), so it is the cheapest OBSERVABLE proof
 * that the consumer's `onReset` ran at all — walking the real
 * credential flow to populate it for real would test a different
 * scenario's claim, not this one's. */
const STORAGE_SENTINEL = JSON.stringify({ endpoint: "http://sentinel.invalid", bucket: "b" });

/** The reset sheet's own controls, read straight from the DOM: this
 * ceremony has no `__demo` account of its own state beyond `open()` (see
 * host/demo.ts's `reset` driving block), so the claims about the arming
 * delay and the confirm gate are DOM reads, matching how a user actually
 * experiences them. */
function resetRoot(page: Page): Promise<{ present: boolean; armed: boolean }> {
  return page.evaluate(() => {
    const root = document.querySelector(".reset-sheet");
    return { present: root !== null, armed: root?.classList.contains("armed") === true };
  });
}

async function waitForArmed(page: Page, timeout = UI_TIMEOUT): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector(".reset-sheet")?.classList.contains("armed") === true,
    undefined,
    { timeout },
  ).catch(async (e) => {
    const r = await resetRoot(page);
    throw new Error(`waiting for the reset sheet to arm: ${JSON.stringify(r)} (${e.message})`);
  });
}

/** localStorage keys the visor's own erase wipes itself (identity, hue,
 * marks) plus every demo-owned key `onReset` must wipe — the set this
 * scenario asserts is gone after a successful erase.
 *
 * `KEYS.hue`, `KEYS.marks` AND the three pairing boot-cache keys
 * (`pm-demo-us-{hue,name,marks}-cache`) are DELIBERATELY
 * NOT in this list — verified directly (a probe boot with an untouched,
 * NEVER-erased context): `reconcileFromDriver` (visor/ui/pairing.ts)
 * unconditionally re-derives and re-writes all three caches from the
 * account driver's own baseline state on EVERY boot, fresh or not
 * (`pm-demo-us-hue-cache: "3"`, `-name-cache: ""`, `-marks-cache: "[]"`
 * on a context that was never seeded and never erased), and a boot that
 * finds no stored anchor likewise persists a freshly-picked one at once
 * (host/demo.ts:1573) and records the just-mounted app as newly seen
 * (`SurfaceMarks`, `firstSeen`). So all five keys are back with FRESH,
 * default-shaped values within the same tick the fresh boot completes,
 * regardless of what `onReset` did — asserting them absent here would be
 * asserting a property no boot of this demo has ever had. The property
 * actually under test — no OLD state survived — is checked directly
 * below via `isNew: true` and the empty petname/identity. */
function allDemoKeys(): string[] {
  return [
    KEYS.identity,
    KEYS.storage,
    KEYS.legacyS3,
    "pm-demo-chrome-hue",
  ];
}

function localStorageSnapshot(page: Page, keys: string[]): Promise<Record<string, string | null>> {
  return page.evaluate(
    (ks: string[]) => Object.fromEntries(ks.map((k) => [k, localStorage.getItem(k)])),
    keys,
  );
}

/** `indexedDB.databases()` — Chromium-only, which is exactly the browser
 * this harness drives (run.ts launches `chromium`). */
function hasKeystoreDb(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.some((d) => d.name === "pm-demo-keystore");
  });
}

const scenario: Scenario = {
  name: "visor-reset",
  why:
    "the erase ceremony arms, refuses a wrong word, and on a correct one wipes every demo-owned key, the signing keystore, and the visor's own records — proven for both the named and the fixed-word ('erase') challenge",
  // `freshAnchor: true` — NOT the ordinary seeded-hue fixture every other
  // scenario uses. `newContext` (e2e/util.ts) seeds KEYS.hue on EVERY
  // document load in the context, including a reload, UNLESS freshAnchor
  // is set: the seed entries are captured once, at context creation, and
  // `freshAnchor` is what keeps hue out of that captured set. Without it
  // the harness's own fixture would silently re-plant `pm-demo-visor-hue`
  // after the erase's reload, which would make this scenario's own
  // sentinel check pass or fail for a reason that has nothing to do with
  // the erase ceremony under test.
  page: { freshAnchor: true },

  async run(page) {
    await act("seed a name, a petname and a storage-config sentinel to lose", async () => {
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      await hook(page, "settings.type", "name", "Ada");
      await hook(page, "settings.type", "device", "study PC");
      await hook(page, "settings.save");
      await waitForSheet(page, "settings", false);
      assertEquals((await identity(page)).name, "Ada", "the seeded name");

      // A petname, so the erase has a mark to lose (the visor's dangerLines
      // promise "every petname and pet icon"; petname-ceremony.ts is the
      // scenario for the ceremony itself, so this is the minimum walk).
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      await hook(page, "naming.type", PETNAME);
      await hook(page, "naming.adoptNomination");
      await hook(page, "naming.save");
      await waitForSheet(page, "naming", false);
      const s = await appSurface(page);
      assertEquals(s?.petname, PETNAME, "the seeded petname");

      // The storage-config sentinel: see STORAGE_SENTINEL's comment for
      // why this is written directly rather than through the credential
      // flow.
      await page.evaluate(
        (v: string) => localStorage.setItem("pm-demo-storage", v),
        STORAGE_SENTINEL,
      );
    });

    await act("the settings sheet offers 'erase this visor…', which opens the reset ceremony", async () => {
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      const hasResetBtn = await page.evaluate(() =>
        document.getElementById("visor-settings-reset") !== null
      );
      assert(hasResetBtn, "no #visor-settings-reset button on the settings sheet");
      await hook(page, "reset.openFromSettings");
      // Opening the reset ceremony closes settings (visor/ui/sheets.ts's
      // resetBtn.onclick: a plain close, then requestReset) — both halves
      // of that one gesture are checked here.
      await waitForSheet(page, "settings", false);
      const r = await resetRoot(page);
      assert(r.present, "the .reset-sheet root did not appear");
    });

    await act("the erase button and the confirm input are disabled before the arming delay elapses", async () => {
      const state = await hook(page, "reset.armingState");
      assertEquals(state.btnText, "arming…", "the erase button's text before arming");
      assertEquals(state.btnDisabled, true, "the erase button before arming");
      assertEquals(state.inputDisabled, true, "the confirm input before arming");
      const r = await resetRoot(page);
      assertEquals(r.armed, false, "the sheet's armed class before ARM_MS has elapsed");
    });

    await act("after the arming delay, the erase control is live and says so", async () => {
      await waitForArmed(page);
      const state = await hook(page, "reset.armingState");
      assertEquals(state.btnText, "erase everything", "the erase button's text once armed");
      assertEquals(state.btnDisabled, false, "the erase button once armed");
      assertEquals(state.inputDisabled, false, "the confirm input once armed");
    });

    await act("a wrong word refuses the erase and changes nothing", async () => {
      await hook(page, "reset.type", "wrong");
      await hook(page, "reset.erase");
      const reason = await hook(page, "reset.reason");
      assertIncludes(reason, "that doesn't match", "the mismatch refusal");
      // Still open, still named: nothing was erased, and there was no
      // navigation — checked via __demo still answering, which a reload
      // would have torn down and rebuilt fresh.
      assertEquals(await hook(page, "reset.open"), true, "the reset sheet after a wrong word");
      assertEquals((await identity(page)).name, "Ada", "the identity after a refused erase");
    });

    await act("the user's own name (case-insensitive) confirms the erase, and the page reloads", async () => {
      await hook(page, "reset.type", "ada"); // lower-case ON PURPOSE — the compare is case-insensitive
      const navigated = page.waitForEvent("load", { timeout: UI_TIMEOUT });
      await hook(page, "reset.erase");
      await navigated;
      await waitForBoot(page);
    });

    await act("after the reload: no name, a fresh app, and every demo-owned key gone", async () => {
      const { top } = await stripText(page);
      assert(!top.includes("Ada"), `the strip still spoke the erased name: ${JSON.stringify(top)}`);
      const s = await appSurface(page);
      assertEquals(s?.isNew, true, "the app surface is NEW again after the erase");
      assertEquals(s?.petname ?? "", "", "the petname after the erase");
      assertEquals((await identity(page)).name ?? "", "", "the identity record after the erase");

      const snap = await localStorageSnapshot(page, allDemoKeys());
      for (const [k, v] of Object.entries(snap)) {
        assertEquals(v, null, `localStorage key ${k} survived the erase`);
      }
      assertEquals(
        await hasKeystoreDb(page),
        false,
        "the signing keystore database survived the erase",
      );
    });

    await act("the FIXED-WORD fallback ('erase'): an unnamed identity still confirms and wipes", async () => {
      // The identity is empty now (the previous act's premise), so the
      // sheet's challenge is the fixed word rather than a name — the
      // other half of the ceremony's confirm logic, exercised for real.
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      await hook(page, "reset.openFromSettings");
      await waitForSheet(page, "settings", false);
      const text = await sheetText(page);
      assertIncludes(text, "type erase to confirm", "the fixed-word challenge label");

      await waitForArmed(page);
      await hook(page, "reset.type", "erase");
      const navigated = page.waitForEvent("load", { timeout: UI_TIMEOUT });
      await hook(page, "reset.erase");
      await navigated;
      await waitForBoot(page);

      const s = await appSurface(page);
      assertEquals(s?.isNew, true, "the app surface is NEW again after the fixed-word erase");
    });
  },
};

export default scenario;
