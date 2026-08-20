// The strip's top line NEVER names a surface that does not own the
// context — not even for one frame, and not because a visor timer that
// was scheduled earlier finally got its turn.
//
// WHY THIS IS A SECURITY SCENARIO AND NOT A COSMETIC ONE. The strip is
// the trust anchor: it is the one place on the page a component cannot
// draw, and its top line answers "whose rectangle am I looking at". A
// user checks it precisely when they are about to do something they
// would not do for the wrong component. A WRONG label there, however
// brief, is not a flicker — it is the anchor making the exact false
// statement it exists to prevent, at the exact moment it is consulted.
//
// The hazard is DEFERRED CONTEXT WRITES. The visor's lightweight sheets
// (naming, settings) close on an animation, and their close paths put
// the strip's context back. Whatever is deferred in that restore is
// racing whatever the user did next — and "open the storage dialog" is
// one click away from "close the naming sheet". A restore that fires
// after a panel surface has mounted would put the APP's name back on the
// top line while the PANEL owns the page.
//
// So the scenario forces that ordering (both ways round) and RECORDS the
// top line continuously rather than sampling it, because the claim is a
// never.
//
// HONEST STATUS OF THIS FILE. Unlike its sibling in
// dialog-close-retirement.ts, this scenario is a REGRESSION GUARD, not
// the reproduction of a defect that was found: it passed against the
// code before the ownership-aware restore went in as well as after. The
// reason is worth writing down, because it is the thing that could stop
// being true. The visor's context writes are all SYNCHRONOUS — the only
// genuinely deferred work in a sheet's close path is the occupancy-
// checked `drawerInner.replaceChildren()`, and the one deferred write
// that does touch the line (the announcement's expiry) reverts by
// RE-RENDERING the current context rather than by restoring a
// remembered one. On top of that, every opener retires the panel before
// it claims the drawer, so no close path has ever yet run while a panel
// surface was live.
//
// That last clause is an accident of call ordering, not a structural
// guarantee — it is exactly the kind of invariant that a later "open
// the sheet without closing the dialog first" quietly repeals. The visor
// now holds it by construction instead (host/demo.ts's
// `restoreVisorContext`: no caller says what the context should become,
// they say only that they are done). This scenario is what notices if
// either half of that regresses.

import type { Scenario } from "../run.ts";
import {
  act,
  assert,
  assertEquals,
  assertIncludes,
  hook,
  recordStripTop,
  sheetOpen,
  sleep,
  stripText,
  waitForPanelSurface,
  waitForSheet,
} from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

/** What the app calls itself, and what the s3 panel calls itself
 * (guest-panel-s3/src/lib.rs:242). The visor quotes both on the top line —
 * so the top line naming one of them is the visor's claim about who owns
 * the page right now. */
const APP = "TodoMVC";
const PANEL = "S3 object storage";

/** Every recorded top-line value that named the app. `""` is not a
 * violation: an empty top line claims nothing, and renderContext clears
 * before it appends. */
const appLabels = (samples: string[]) => samples.filter((s) => s.includes(APP));

/** How long to watch after the mount. Comfortably longer than the
 * drawer's ARM_MS (700ms, host/demo.ts:2321) — which is the delay every
 * lightweight sheet's deferred close work is scheduled on, and therefore
 * the window a late restore would land in. */
const WATCH_MS = 1_500;

const scenario: Scenario = {
  name: "strip-ownership",
  why:
    "no deferred visor timer ever puts the app's name back on the strip while a panel surface owns it",
  minio: "up",
  page: (ctx) => ({
    storage: {
      "pm-demo-storage": JSON.stringify({
        provider: "s3",
        endpoint: ctx.minioUrl,
        bucket: "pm-demo",
        access: ctx.minioAccess,
      }),
    },
  }),

  async run(page: Page) {
    await act("the strip names the app before anything is opened", async () => {
      const { top } = await stripText(page);
      assertIncludes(top, APP, "the top line at rest");
    });

    await act("closing the naming sheet and opening storage IN THE SAME TASK", async () => {
      // THE PROVOCATION. The naming sheet is opened from the strip's own
      // control, then closed and the storage dialog opened with NO gap:
      // one page task, so anything the close path defers is scheduled
      // BEFORE the mount begins and fires DURING or AFTER it.
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      assertEquals(await sheetOpen(page, "naming"), true, "the naming sheet before the race");

      // Recording starts BEFORE the race so the first wrong value cannot
      // land in a gap.
      const strip = await recordStripTop(page);

      await page.evaluate(() => {
        // deno-lint-ignore no-explicit-any
        const demo = (globalThis as any).__demo;
        // Cancel CLICKS the sheet's real button — the same path a user
        // takes — and openStorage follows in the same turn.
        demo.naming.cancel();
        demo.openStorage();
      });

      await waitForPanelSurface(page);
      // From here the panel owns the context: it is mounted, registered
      // and bound. Everything the top line says from now until the watch
      // expires is a claim about a live panel surface.
      const afterMount = (await strip.samples()).length;
      await sleep(WATCH_MS);
      const samples = await strip.stop();

      const top = (await stripText(page)).top;
      assertIncludes(top, PANEL, "the top line once the panel is mounted");

      const late = appLabels(samples.slice(afterMount));
      assert(
        late.length === 0,
        `the strip named the app while the panel surface owned the context: ${
          JSON.stringify(late)
        } (full trace: ${JSON.stringify(samples)})`,
      );
    });

    await act("and the inverse ordering: the sheet is closed AFTER the panel mounts", async () => {
      // The other way round. The naming sheet cannot be open at the same
      // time as the storage dialog (the dialog paints in the top layer,
      // so the openers close each other) — which means the ordering that
      // matters here is a close path RUNNING LATE, after a mount it did
      // not know about. Driving both closes against a live panel session
      // is the reachable form of that: whatever they defer must find the
      // panel in possession and leave the line alone.
      const strip = await recordStripTop(page);
      const before = (await strip.samples()).length;

      await page.evaluate(() => {
        // deno-lint-ignore no-explicit-any
        const demo = (globalThis as any).__demo;
        // Both lightweight tenants' close paths, fired while the panel
        // surface is live and owns the strip. Neither has a session to
        // close, which is exactly the shape a LATE close takes: the
        // session it belonged to is already gone.
        demo.naming.cancel();
        demo.settings.cancel();
      });

      await sleep(WATCH_MS);
      const samples = await strip.stop();
      const late = appLabels(samples.slice(before));
      assert(
        late.length === 0,
        `a late sheet close relabelled the strip while the panel was live: ${
          JSON.stringify(late)
        } (full trace: ${JSON.stringify(samples)})`,
      );
      assertIncludes((await stripText(page)).top, PANEL, "the top line after the late closes");
    });

    await act("dismissing the dialog hands the strip back to the app", async () => {
      // The inverse claim, so the one above cannot pass by the strip
      // being stuck: when the panel really is retired, the app's name
      // comes back.
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => ((document.querySelector("#visor-context .ctx-top")?.textContent) ?? "")
          .includes("TodoMVC"),
        undefined,
        { timeout: 15_000 },
      ).catch(() => {
        throw new Error("the strip never returned to the app after the dialog was dismissed");
      });
    });
  },
};

export default scenario;
