// Leaving the storage page — by ANY path — retires the panel, and the
// anchor is watchable the whole time.
//
// WHAT THIS SCENARIO USED TO BE. The storage configuration was a modal
// `<dialog>`, and this file was `dialog-close-retirement`: a modal closes
// natively on ESC, with no script of the demo's involved, so the visor
// could not treat "the dialog closed" as something only its own Cancel
// handler caused — it listened for the `close` event, and for the `open`
// attribute mutation as well, because at least one embedding delivers the
// event late or not at all. A component surface left running behind a
// closed dialog is a component still executing with a grant the user
// believes they dismissed, so all of that machinery was load-bearing.
//
// IT IS GONE BY CONSTRUCTION. Storage is a sibling PAGE now, under the
// same pinned strip (web/index.html's #page-track), and leaving is a
// function call rather than an event that might arrive: there is no top
// layer, nothing to close, and no engine-specific close semantics to
// reconcile. What survives is the PROPERTY the machinery existed to
// defend, which is why this file survives too — no path may leave a live
// panel session off-screen — plus one claim the modal made untestable
// because it was untrue: while the panel's page is up, the visor strip is
// visible and unobscured, and it names the panel.
//
// The paths, all three of them: the visor's own Cancel, the browser's
// Back button (a page is a place, so Back is now a close path and was not
// one before), and the Save commit's handoff into the credential sheet
// (that one is credential-flow.ts's, asserted where the sheet is).

import type { Ctx, Scenario } from "../run.ts";
import {
  act,
  ANNOUNCE_MS,
  assert,
  assertEquals,
  assertIncludes,
  assertList,
  consoleLog,
  frameProbe,
  hook,
  onStoragePage,
  paneStatus,
  regionText,
  sheetOpen,
  stripText,
  stripUnobscured,
  UI_TIMEOUT,
  waitForBottom,
  waitForDrawerHidden,
  waitForPanelSurface,
  waitForStoragePage,
} from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

/** Is the s3 panel's surface still LIVE in the visor's hands? `openFor` is
 * provenance-keyed and opens nothing for a surface the visor no longer
 * holds, so it doubles as a precise retirement probe — precise in a way
 * counting iframes is not. */
const panelLive = (page: Page) =>
  page.evaluate(() =>
    // deno-lint-ignore no-explicit-any
    (globalThis as any).__demo.naming.openFor("panel-s3") === true
  );

const scenario: Scenario = {
  name: "storage-page-navigation",
  why:
    "every way of leaving the storage page retires the panel, and the strip stays visible and correct while it is up",
  minio: "up",
  // A configured store, so the panel mounts with a real destination —
  // which is both the ordinary case and what makes the visor's binding
  // (and so the "is the panel registered yet" wait) meaningful.
  page: (ctx: Ctx) => ({
    storage: {
      "pm-demo-storage": JSON.stringify({
        provider: "s3",
        endpoint: ctx.minioUrl,
        bucket: "pm-demo",
        access: ctx.minioAccess,
      }),
    },
  }),

  async run(page) {
    let framesWithPanel = 0;
    await act("the storage page mounts the s3 panel as a sandboxed surface", async () => {
      const before = await frameProbe(page);
      await hook(page, "openStorage");
      await waitForPanelSurface(page);
      assertEquals(await onStoragePage(page), true, "the storage page after openStorage");
      const after = await frameProbe(page);
      framesWithPanel = after.appFrames;
      assert(
        after.appFrames > before.appFrames,
        `no panel frame was mounted (${before.appFrames} → ${after.appFrames})`,
      );
      // The panel is an APP: its own region, its own grants, and — like
      // every other component surface — unreachable from the visor's realm.
      assertEquals(after.sameOriginReachable, false, "the panel frame was same-origin reachable");
      assert(
        after.sandbox.every((s) => s !== null && !s.includes("allow-same-origin")),
        `a surface frame carried allow-same-origin: ${JSON.stringify(after.sandbox)}`,
      );
    });

    await act("the ANCHOR is watchable while the panel's page is up, and names the panel", async () => {
      // THE REASON THE MODAL WENT. A <dialog> paints in the top layer —
      // above #visor-zone — and its ::backdrop dims everything beneath
      // it, so the strip's flip to the arriving component (its NEW
      // marker, the offer to name it: the whole TOFU beat) happened in
      // pixels the user was being pushed away from, if they were even
      // painted. Nothing may paint over or dim a component surface's
      // anchor except the visor itself.
      //
      // A HIT TEST is what makes this a real claim rather than a style
      // read: `elementFromPoint` at the strip's centre returns what the
      // user would actually touch there, so a top-layer element, a
      // backdrop or any stray overlay fails it.
      const strip = await stripUnobscured(page);
      assertEquals(strip.visible, true, "the strip's box while the storage page is up");
      assertEquals(strip.hitInStrip, true, "the strip was painted over while the storage page was up");
      // And the dim layer — the visor's own, used for its sheets — is
      // not up either: walking to a page is not a modal interaction.
      assertEquals(
        await page.evaluate(() => (document.getElementById("visor-dim") as HTMLElement).hidden),
        true,
        "the visor dim while the storage page is up",
      );
      // THE LOUD HANDOFF, first. Arriving on the panel's page is
      // ANNOUNCED on the visor's own line — the beat the modal made
      // invisible is now both visible and said — and an announcement
      // owns the bottom line for its window (visor/ui/visor.ts).
      // Framework voice throughout: it describes the component rather
      // than quoting it, because a flat string cannot carry the app-voice
      // marking that a nickname would need.
      const said = await waitForBottom(
        page,
        (t) => t.includes("this page is drawn by"),
        "the arrival announcement",
      );
      assert(
        !said.includes("panel-s3"),
        `the announcement carried the component's own key: ${JSON.stringify(said)}`,
      );
      // Then the line REVERTS to the surface it is about, by re-render.
      // Waiting for that is deterministic (the announcement expires on
      // its own timer) and asserts the anchor is not merely visible but
      // CORRECT: it names the surface the user is looking at.
      // The line carries what the component CALLS ITSELF (app voice:
      // quoted, monospaced, plated), not the provenance key the visor
      // fetched it by — the key is a sheet's business, not the strip's.
      await waitForBottom(
        page,
        (t) => t.includes("S3 object storage"),
        "the surface-name line after the arrival announcement",
        ANNOUNCE_MS + 5_000,
      );
    });

    await act("the browser's own Back — not the visor's Cancel — leaves the page", async () => {
      // The path that did not exist before: a place the user walks to is
      // a place they can walk back from with the gesture they already
      // have. This is a REAL history navigation, with no script of the
      // demo's involved in causing it — the same role ESC played for the
      // modal.
      await page.goBack();
      await waitForStoragePage(page, false);
      assertEquals(await onStoragePage(page), false, "the storage page after Back");
    });

    await act("the panel is RETIRED, not left running on a page nobody is on", async () => {
      // The claim with teeth, and the one the whole close-event edifice
      // existed to make: a surface that kept executing after the user
      // navigated away would still hold the grants the navigation was
      // meant to end.
      await page.waitForFunction(
        (n: number) => document.querySelectorAll("iframe").length < n,
        framesWithPanel,
        { timeout: UI_TIMEOUT },
      ).catch(() => {
        throw new Error("the panel frame was still mounted after Back");
      });
      assertEquals(await panelLive(page), false, "the visor still held the panel's surface after Back");
    });

    await act("the strip's context returns to the app surface", async () => {
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "TodoMVC", "the surface-name line after leaving the storage page");
      assertEquals(await sheetOpen(page, "drawer"), false, "a credential sheet after Back");
      assertEquals(await sheetOpen(page, "naming"), false, "a naming sheet after Back");
      assertEquals(await sheetOpen(page, "settings"), false, "a settings sheet after Back");
      // No stranded visor furniture: the drawer and the dim are both
      // away, so the page is fully the user's again.
      await waitForDrawerHidden(page);
      await page.waitForFunction(
        () => (document.getElementById("visor-dim") as HTMLElement).hidden === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
    });

    await act("the visor's own Cancel is the same close path, and re-entry works", async () => {
      // Retirement left the visor in a re-usable state rather than a
      // half-torn-down one — and the second exit takes the OTHER route,
      // so both user-driven paths are exercised in one scenario.
      await hook(page, "openStorage");
      await waitForPanelSurface(page);
      assertEquals(await onStoragePage(page), true, "the storage page on a second entry");
      await page.click("#storage-cancel");
      await waitForStoragePage(page, false);
      assertEquals(await panelLive(page), false, "the panel surface after Cancel");
    });

    await act("leave-then-REENTER with no gap, ten times, mounts cleanly every time", async () => {
      // THE PROVOCATION for the teardown/remount race, kept verbatim in
      // spirit from the scenario this replaces.
      //
      // The race it hunts is NOT about the dialog's close semantics —
      // those are gone — but about the asynchrony that outlived them:
      // `mountPanel` fetches an artifact and completes a frame handshake,
      // so a mount can still finish after the session that asked for it
      // ended. The visor's answers to that are a generation counter and
      // an awaited teardown completion (host/demo.ts), and this is what
      // exercises them: leave and re-enter in the SAME driver round trip,
      // as tight as the page can make it, ten times, because the race is
      // probabilistic and one iteration is a coin toss rather than a
      // test. No `sleep`, no settle.
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => {
          // Cancel's own effect, in-page and synchronous, immediately
          // followed by the re-entry.
          (document.getElementById("storage-cancel") as HTMLButtonElement).click();
          // deno-lint-ignore no-explicit-any
          (globalThis as any).__demo.openStorage();
        });
        await waitForPanelSurface(page).catch(async (e) => {
          throw new Error(`re-entry ${i + 1}/10 never registered a panel surface: ${e.message}`);
        });
        assertEquals(await onStoragePage(page), true, `the storage page on re-entry ${i + 1}/10`);
        // The region holds the surface's iframe and NOTHING else: any
        // text in it is the visor's mount `.catch` reporting a failure.
        assertEquals(await regionText(page), "", `the panel region on re-entry ${i + 1}/10`);
      }
      // Nothing anywhere reported a frame that died before it was ready
      // — not the region (checked per iteration), not a pane's status,
      // and not the console.
      for (const pane of ["alice", "bob", "tablet"] as const) {
        const status = await paneStatus(page, pane);
        assert(
          !status.includes("frame backend destroyed"),
          `${pane}'s status reported a destroyed frame backend: ${JSON.stringify(status)}`,
        );
      }
      const noisy = consoleLog(page).filter((l) => l.includes("frame backend destroyed"));
      assertList(noisy, [], "console complaints about a destroyed frame backend");
      // Leave the storage page, as the acts above found it.
      await page.click("#storage-cancel");
      await waitForStoragePage(page, false);
    });
  },
};

export default scenario;
