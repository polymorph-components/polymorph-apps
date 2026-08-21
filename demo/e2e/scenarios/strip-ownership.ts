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
// racing whatever the user did next — and "walk to the storage page" is
// one click away from "close the naming sheet". A restore that fires
// after a panel surface has mounted would put the APP's name back on the
// top line while the PANEL owns the page.
//
// So the scenario forces that ordering (both ways round) and RECORDS the
// top line continuously rather than sampling it, because the claim is a
// never.
//
// HONEST STATUS OF THIS FILE. Unlike its sibling in
// storage-page-navigation.ts, this scenario is a REGRESSION GUARD, not
// the reproduction of a defect that was found: it passed against the
// code before the ownership-aware restore went in as well as after. The
// reason is worth writing down, because it is the thing that could stop
// being true. The visor's context writes are all SYNCHRONOUS — the only
// genuinely deferred work in a sheet's close path is the occupancy-
// checked `drawerInner.replaceChildren()`, and the one deferred write
// that does touch the line (the announcement's expiry) reverts by
// RE-RENDERING the current context rather than by restoring a
// remembered one. On top of that, every opener USED TO retire the panel
// before it claimed the drawer, so no close path had yet run while a
// panel surface was live.
//
// THAT CLAUSE HAS NOW BEEN REPEALED ON PURPOSE, which is the best thing
// that could have happened to this file. It was always an accident of
// call ordering rather than a structural guarantee — exactly the kind of
// invariant a later "open the sheet without leaving the panel's page
// first" quietly removes — and that is precisely what replacing the
// storage modal with a sibling page did: a sheet now opens above the
// strip while a panel surface stays live on the page below (see
// tenant-precedence.ts). So the ordering this scenario forces is
// reachable by ordinary use now, not only by driving. The visor holds
// the property by construction (host/demo.ts's
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
  recordSurfaceLine,
  waitForBottom,
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
      // The component's own name is the BOTTOM line's business now (the
      // top line is the user's mark and word); which SURFACE the strip
      // is about is unchanged, and that is what this scenario watches.
      const { bottom } = await stripText(page);
      assertIncludes(bottom, APP, "the surface-name line at rest");
    });

    await act("closing the naming sheet and opening storage IN THE SAME TASK", async () => {
      // THE PROVOCATION. The naming sheet is opened from the strip's own
      // control, then closed and the storage page entered with NO gap:
      // one page task, so anything the close path defers is scheduled
      // BEFORE the mount begins and fires DURING or AFTER it.
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      assertEquals(await sheetOpen(page, "naming"), true, "the naming sheet before the race");

      // Recording starts BEFORE the race so the first wrong value cannot
      // land in a gap.
      const strip = await recordSurfaceLine(page);

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
      // and bound. Everything the surface-name line says from now until
      // the watch expires is a claim about a live panel surface.
      const afterMount = (await strip.samples()).length;
      await sleep(WATCH_MS);
      const samples = await strip.stop();

      // The line names the panel, and it does so WITHOUT A WINDOW TO WAIT
      // OUT. The arrival used to be ANNOUNCED (host/demo.ts's loud
      // handoff), which owned the bottom line for 8s, so this read had to
      // be deferred past the announcement's expiry before it was about
      // anything. The handoff is a PULSE now — it points at the lines
      // instead of replacing them — so the surface-name line is correct
      // from the mount onward and the ordinary UI timeout is the right
      // bound. Same claim, arrived at sooner and with a tighter fence.
      // (The predicate is stringified and evaluated IN THE PAGE, so it
      // closes over nothing — PANEL is spelled out rather than captured.)
      await waitForBottom(
        page,
        (t) => t.includes("S3 object storage"),
        "the surface-name line once the panel is mounted",
      );

      const late = appLabels(samples.slice(afterMount));
      assert(
        late.length === 0,
        `the strip named the app while the panel surface owned the context: ${
          JSON.stringify(late)
        } (full trace: ${JSON.stringify(samples)})`,
      );
    });

    await act("and the inverse ordering: the sheet is closed AFTER the panel mounts", async () => {
      // The other way round: a close path RUNNING LATE, after a mount it
      // did not know about. Firing both closes against a live panel
      // session is that ordering — and it is an ORDINARY one now that a
      // sheet and the storage page coexist, where it used to be
      // reachable only by driving (the modal forced the openers to close
      // each other). Whatever the closes defer must find the panel in
      // possession and leave the line alone.
      const strip = await recordSurfaceLine(page);
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
      assertIncludes(
        (await stripText(page)).bottom,
        PANEL,
        "the surface-name line after the late closes",
      );
    });

    await act("leaving the storage page hands the strip back to the app", async () => {
      // The inverse claim, so the one above cannot pass by the strip
      // being stuck: when the panel really is retired, the app's name
      // comes back. Driven through the browser's own Back button — the
      // close path that is not the visor's own code, which is the role
      // ESC played while this was a modal.
      await page.goBack();
      await page.waitForFunction(
        () => ((document.querySelector("#visor-context .ctx-bottom")?.textContent) ?? "")
          .includes("TodoMVC"),
        undefined,
        { timeout: 15_000 },
      ).catch(() => {
        throw new Error("the strip never returned to the app after leaving the storage page");
      });
    });
  },
};

export default scenario;
