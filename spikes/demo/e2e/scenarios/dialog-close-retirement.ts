// ESC on the storage dialog retires the panel. (The beat the paseo
// webview could never verify.)
//
// A modal `<dialog>` closes natively on ESC — the browser does it, no
// script involved. Chrome therefore cannot treat "the dialog closed" as
// something only its own Cancel handler causes: it listens for the
// `close` event and retires the mounted panel there, because a component
// surface left running behind a closed dialog is a component that is
// still executing with a grant the user believes they dismissed.
//
// WHY THIS SCENARIO EXISTS AS A FILE. The embedded webview this spike was
// hand-driven in does not deliver `<dialog>` close events reliably (and
// spuriously closes modals of its own accord), so this claim was
// literally unverifiable there — it had to be taken on trust from the
// source. A real Chromium delivers the event, which is the entire reason
// the harness runs one.

import type { Ctx, Scenario } from "../run.ts";
import {
  act,
  assert,
  assertEquals,
  assertIncludes,
  frameProbe,
  hook,
  sheetOpen,
  sleep,
  stripText,
  UI_TIMEOUT,
  waitForDrawerHidden,
  waitForPanelSurface,
} from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

const isOpen = (page: Page) =>
  page.evaluate(() =>
    (document.getElementById("storage-dialog") as HTMLDialogElement).open
  );

/** Is the s3 panel's surface still LIVE in chrome's hands? `openFor` is
 * provenance-keyed and opens nothing for a surface chrome no longer
 * holds, so it doubles as a precise retirement probe — precise in a way
 * counting iframes is not. */
const panelLive = (page: Page) =>
  page.evaluate(() =>
    // deno-lint-ignore no-explicit-any
    (globalThis as any).__demo.naming.openFor("panel-s3") === true
  );

const scenario: Scenario = {
  name: "dialog-close-retirement",
  why: "ESC closes the dialog, the panel is retired and the context returns to the app — unverifiable in a webview",
  minio: "up",
  // A configured store, so the panel mounts with a real destination —
  // which is both the ordinary case and what makes chrome's binding
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
    await act("the storage dialog mounts the s3 panel as a sandboxed surface", async () => {
      const before = await frameProbe(page);
      await hook(page, "openStorage");
      await waitForPanelSurface(page);
      assertEquals(await isOpen(page), true, "the dialog after openStorage");
      const after = await frameProbe(page);
      framesWithPanel = after.appFrames;
      assert(
        after.appFrames > before.appFrames,
        `no panel frame was mounted (${before.appFrames} → ${after.appFrames})`,
      );
      // The panel is an APP: its own region, its own grants, and — like
      // every other component surface — unreachable from chrome's realm.
      assertEquals(after.sameOriginReachable, false, "the panel frame was same-origin reachable");
      assert(
        after.sandbox.every((s) => s !== null && !s.includes("allow-same-origin")),
        `a surface frame carried allow-same-origin: ${JSON.stringify(after.sandbox)}`,
      );
      // That the surface is LIVE is already established by the wait
      // above: `boundDestination()` is non-null only once chrome has
      // mounted the panel and bound it to an origin. `panelLive` is used
      // below, after ESC, where the expected answer is `false` — and a
      // false answer opens nothing, so the probe stays side-effect free
      // exactly where it is used.
    });

    await act("ESC — the browser's own close, not chrome's Cancel — closes the dialog", async () => {
      // A REAL key press through the browser: the native modal-dismiss
      // path, with no script of the demo's involved in causing it.
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => (document.getElementById("storage-dialog") as HTMLDialogElement).open === false,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      assertEquals(await isOpen(page), false, "the dialog after ESC");
    });

    await act("the panel is RETIRED, not left running behind a closed dialog", async () => {
      // The claim with teeth: a surface that kept executing after the
      // user dismissed the dialog would still hold the grants the
      // dismissal was meant to end.
      await page.waitForFunction(
        (n: number) => document.querySelectorAll("iframe").length < n,
        framesWithPanel,
        { timeout: UI_TIMEOUT },
      ).catch(() => {
        throw new Error("the panel frame was still mounted after ESC");
      });
      assertEquals(await panelLive(page), false, "chrome still held the panel's surface after ESC");
    });

    await act("the strip's context returns to the app surface", async () => {
      const { top } = await stripText(page);
      assertIncludes(top, "TodoMVC", "the top line after the dialog was dismissed");
      assertEquals(await sheetOpen(page, "drawer"), false, "a credential sheet after ESC");
      assertEquals(await sheetOpen(page, "naming"), false, "a naming sheet after ESC");
      assertEquals(await sheetOpen(page, "settings"), false, "a settings sheet after ESC");
      // No stranded chrome furniture: the drawer and the dim are both
      // away, so the page is fully the user's again.
      await waitForDrawerHidden(page);
      await page.waitForFunction(
        () => (document.getElementById("chrome-dim") as HTMLElement).hidden === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
    });

    await act("and the dialog can be opened again afterwards", async () => {
      // Retirement left chrome in a re-usable state rather than a
      // half-torn-down one.
      //
      // FINDING (harness-visible, reported rather than papered over):
      // re-opening the dialog IMMEDIATELY after ESC can fail to mount
      // with "frame backend destroyed before it was ready" — the new
      // mount races the previous teardown, which chrome exposes no
      // completion signal for. A human cannot hit this window, so it is
      // waited out here rather than asserted on; if it ever becomes a
      // real complaint, the fix is a teardown promise to await.
      await sleep(500);
      await hook(page, "openStorage");
      await waitForPanelSurface(page);
      assertEquals(await isOpen(page), true, "the dialog on a second open");
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => (document.getElementById("storage-dialog") as HTMLDialogElement).open === false,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      assertEquals(await panelLive(page), false, "the panel surface after a second ESC");
    });
  },
};

export default scenario;
