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
  assert,
  assertEquals,
  assertIncludes,
  assertList,
  backControl,
  consoleLog,
  frameProbe,
  hook,
  onStoragePage,
  paneStatus,
  PULSE_MS,
  regionText,
  sheetOpen,
  stripText,
  stripUnobscured,
  UI_TIMEOUT,
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
    await act("the strip carries NO back control while the user is home", async () => {
      // Absence, not a disabled button: the control means "you are
      // somewhere, not home", so at home there is nothing to render. An
      // affordance that is present but inert teaches the user to
      // distrust the ones that are present and live.
      const back = await backControl(page);
      assertEquals(back.present, false, "a back control on the main page");
    });

    let framesWithPanel = 0;
    await act("the storage page mounts the s3 panel as a sandboxed surface", async () => {
      const before = await frameProbe(page);
      // THE PULSE IS A TRANSIENT, so it is RECORDED rather than sampled:
      // the arrival cue lives 1.8s and a later act could easily arrive
      // after it cleared, which would make a poll flaky in the direction
      // that hides regressions. The observer is installed BEFORE the
      // navigation, and it captures the bottom line's text AT THE INSTANT
      // the class lands — which is what makes claim (c) below a statement
      // about the arrival moment itself rather than about some later one.
      await page.evaluate(() => {
        const el = document.getElementById("visor-context")!;
        // deno-lint-ignore no-explicit-any
        const log: any[] = [];
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__pulseLog = log;
        let on = false;
        new MutationObserver(() => {
          const now = el.classList.contains("pulse");
          if (now && !on) {
            log.push({
              at: performance.now(),
              clearedAt: null,
              bottom: el.querySelector(".ctx-bottom")?.textContent ?? "",
              // The cluster's live position, captured WHILE the cue is
              // painting. The first pulse implementation put a `margin`
              // shorthand on the cluster and silently clobbered its
              // `margin-right: auto` — every pulse shoved the whole
              // cluster ~340px sideways and snapped it back. A cue that
              // moves the text it points at is a bug the rest-state
              // geometry scenario cannot see, so it is pinned here, at
              // the only moment it can be observed.
              x: el.getBoundingClientRect().x,
            });
          } else if (!now && on && log.length > 0) {
            log[log.length - 1].clearedAt = performance.now();
          }
          on = now;
        }).observe(el, { attributes: true, attributeFilter: ["class"] });
      });
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
      // THE LOUD HANDOFF, first — and it is a PULSE now, not a timed
      // sentence. The visor points at its own context lines
      // (visor/ui/visor.ts's `pulseContext`) instead of paraphrasing
      // them on the bottom line for 8s.
      //
      // why: the old design ANNOUNCED the arrival, which meant the
      // bottom line spent its most important seconds saying "the strip
      // above says NEW" while covering the strip's own answer. So claim
      // (c) below is a STRENGTHENING the old design could not make at
      // all: it asserts the panel's app-voice content is on the line
      // IMMEDIATELY on arrival, where before it was necessarily absent
      // until the announcement expired.
      //
      // (a) the cue itself: the class the animation hangs off, caught by
      // the recorder installed before the navigation.
      await page.waitForFunction(
        // deno-lint-ignore no-explicit-any
        () => ((globalThis as any).__pulseLog ?? []).length > 0,
        undefined,
        { timeout: UI_TIMEOUT },
      ).catch((e) => {
        throw new Error(`waiting for the arrival pulse on the context cluster: ${e.message}`);
      });

      // (b) the screen-reader channel. The pulse carries no words on
      // screen, so the sentence a non-visual user gets lives in the
      // strip's visually-hidden live region — and it is subject to the
      // SAME voice policy the announcement was: framework voice,
      // describing the component rather than quoting it, because a flat
      // string cannot carry the app-voice marking a nickname would need.
      const spoken = await page.waitForFunction(
        () => {
          const t = document.getElementById("visor-live")?.textContent ?? "";
          return t.includes("this page is now drawn by") ? t : false;
        },
        undefined,
        { timeout: UI_TIMEOUT },
      ).then((h) => h.jsonValue() as Promise<string>).catch((e) => {
        throw new Error(`waiting for the arrival sentence in #visor-live: ${e.message}`);
      });
      assert(
        !spoken.includes("panel-s3"),
        `the live region carried the component's own key: ${JSON.stringify(spoken)}`,
      );

      // THE UNFORGEABLE EXIT, in the same breath as the visibility
      // claim, because they are halves of one property: the anchor is
      // watchable AND it is the way out. The frame's own Cancel button
      // is visor pixels too, but it sits in scrollable content that an
      // app can reproduce pixel for pixel inside its own rectangle;
      // `closest("#visor-strip")` is the assertion that this one does
      // not — it is in the region no component can draw.
      const back = await backControl(page);
      assertEquals(back.present, true, "the back control on the storage page");
      assertEquals(back.inStrip, true, "the back control lives inside the visor strip");
      // Framework voice, naming the RETURN. The app is unnamed in this
      // scenario, so the visor describes it rather than borrowing a word
      // the user never wrote.
      assertEquals(back.label, "back to the app", "the back control's accessible name");

      // (c) and the line the pulse points AT was ALREADY CORRECT at the
      // instant the cue fired: what the component CALLS ITSELF (app
      // voice: quoted, monospaced, plated), not the provenance key the
      // visor fetched it by — the key is a sheet's business, not the
      // strip's. Read from the recorder's snapshot, so this is a claim
      // about the arrival moment and not about the aftermath.
      const pulses = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__pulseLog as { at: number; clearedAt: number | null; bottom: string; x: number }[]
      );
      assertIncludes(
        pulses[0].bottom,
        "S3 object storage",
        "the surface-name line AT THE INSTANT the arrival pulse fired",
      );

      // (d) and the cue is timed: it clears itself within the animation's
      // life (visor/ui/visor.css `visor-ctx-pulse`, PULSE_MS) — an
      // attention cue that stayed up would stop being one.
      const cleared = await page.waitForFunction(
        () => {
          // deno-lint-ignore no-explicit-any
          const log = (globalThis as any).__pulseLog as { clearedAt: number | null }[];
          return log[0]?.clearedAt === null ? false : log[0].clearedAt;
        },
        undefined,
        { timeout: PULSE_MS + 5_000 },
      ).then((h) => h.jsonValue() as Promise<number>).catch((e) => {
        throw new Error(`the arrival pulse never cleared: ${e.message}`);
      });
      const lived = cleared - pulses[0].at;
      assert(
        lived <= PULSE_MS + 2_000,
        `the arrival pulse outlived its animation: ${Math.round(lived)}ms (PULSE_MS=${PULSE_MS})`,
      );

      // (e) and the cue DID NOT MOVE what it points at. The recorder
      // captured the cluster's x while the wash was painting; compared
      // against the settled position, they must be the same pixel. This
      // is the regression the first implementation shipped (see the
      // recorder's comment): rest-state geometry checks are blind to a
      // shift that begins and ends inside the cue's own lifetime.
      const settledX = await page.evaluate(() =>
        document.getElementById("visor-context")!.getBoundingClientRect().x
      );
      assert(
        Math.abs(pulses[0].x - settledX) < 1,
        `the pulse moved the context cluster: x=${pulses[0].x} during, ${settledX} at rest`,
      );
    });

    await act("the chevron survives the arrival cue and the context flips under it", async () => {
      // PRESENCE IS A FACT ABOUT WHERE THE USER IS, not about what the
      // strip currently says — so the control must outlive every render
      // cycle that runs during the stay. By this point the context lines
      // were re-rendered at mount (the flip to the panel's identity) and
      // the arrival pulse has come and gone (the act above watched it
      // clear), and the control is still there: a promise that lapsed
      // mid-visit would be worse than one never made.
      const back = await backControl(page);
      assertEquals(back.present, true, "the back control after the arrival cue cleared");
      assertEquals(back.inStrip, true, "the back control after the arrival cue cleared");
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

    await act("the back control goes with the place it exits", async () => {
      // The inverse of the first act, and the one that keeps the anchor
      // honest: an exit affordance that outlived the place it exits
      // would be the strip making a false statement about where the user
      // is, which is the one thing it may not do.
      const back = await backControl(page);
      assertEquals(back.present, false, "a back control after leaving the storage page");
    });

    await act("the STRIP'S OWN back control is a third door to the same teardown", async () => {
      // The claim with teeth for this control: it is not a decoration
      // beside the real exits, it runs the SAME `closeStorage` — panel
      // retired, page left, history synced, context returned. Driven as
      // a real click on visor pixels, which is the only way a user can
      // reach it.
      await hook(page, "openStorage");
      await waitForPanelSurface(page);
      assertEquals(await onStoragePage(page), true, "the storage page on a second entry");
      await page.click("#visor-back");
      await waitForStoragePage(page, false);
      assertEquals(await panelLive(page), false, "the panel surface after the chevron");
      assertEquals((await backControl(page)).present, false, "the back control after the chevron");
      assertEquals(
        await page.evaluate(() => JSON.stringify(history.state)),
        JSON.stringify({ page: "main" }),
        "the history entry after the chevron",
      );
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "TodoMVC", "the surface-name line after the chevron");
    });

    await act("the visor's own Cancel is the same close path, and re-entry works", async () => {
      // Retirement left the visor in a re-usable state rather than a
      // half-torn-down one — and this exit takes the THIRD route, so all
      // three doors are exercised in one scenario.
      await hook(page, "openStorage");
      await waitForPanelSurface(page);
      assertEquals(await onStoragePage(page), true, "the storage page on a third entry");
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
