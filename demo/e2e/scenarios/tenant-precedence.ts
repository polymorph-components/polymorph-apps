// Who may take the drawer from whom.
//
// The visor has ONE drawer and three tenants for it: the credential sheet,
// the App settings sheet (naming, grown) and the visor's own settings
// sheet. The precedence is not symmetric, and the asymmetry is the whole
// security content:
//
//   - the CREDENTIAL sheet wins outright. A sheet that is collecting (or
//     about to accept) secrets is never displaced by anything, because
//     the displacement itself would be the attack: a surface swapped
//     under a user who is mid-keystroke.
//   - the two LIGHTWEIGHT tenants evict each other freely. Neither holds
//     anything a user would lose by a stray tap on the strip.
//   - the storage DIALOG is a modal in the top layer, so it cannot merely
//     overlap a sheet — the visor closes the sheet rather than strand it
//     behind a modal it would paint over.
//
// Every one of these is a click a user can make in the wrong order, and
// each was previously verified by remembering to try it.

import type { Ctx, Scenario } from "../run.ts";
import {
  act,
  assert,
  assertEquals,
  assertIncludes,
  backControl,
  hook,
  onStoragePage,
  sheetOpen,
  stripText,
  stripUnobscured,
  UI_TIMEOUT,
  waitForDrawerHidden,
  waitForPanelSurface,
  waitForSheet,
  waitForStoragePage,
} from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

const scenario: Scenario = {
  name: "tenant-precedence",
  why:
    "the credential sheet is never displaced; the lightweight sheets evict each other; the storage page and the sheets coexist",
  minio: "up",
  // A COMMITTABLE config: with empty fields the panel refuses to commit
  // (and says so in its own region), so there would be no credential
  // sheet to test the precedence of. The secret is deliberately absent —
  // this scenario is about who owns the drawer, and an unheld key means
  // the sheet really is asking for one.
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
    await act("naming and settings evict each other, both ways", async () => {
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      // Settings, over an open naming sheet.
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      assertEquals(await sheetOpen(page, "naming"), false, "the naming sheet after settings opened");
      // Exactly one tenant in the drawer, always: the eviction is a
      // REPLACEMENT, not a stack.
      const sheets = await page.evaluate(() => ({
        name: document.querySelectorAll("#visor-drawer-inner .name-sheet").length,
        settings: document.querySelectorAll("#visor-drawer-inner .settings-sheet").length,
      }));
      assertEquals(sheets.name, 0, "naming sheets left in the drawer");
      assertEquals(sheets.settings, 1, "settings sheets in the drawer");

      // And back the other way.
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      assertEquals(
        await sheetOpen(page, "settings"),
        false,
        "the settings sheet after naming opened",
      );
      assertEquals(
        await page.evaluate(() =>
          document.querySelectorAll("#visor-drawer-inner .settings-sheet").length
        ),
        0,
        "settings sheets left in the drawer",
      );
    });

    await act("the strip always names whichever sheet actually owns the drawer", async () => {
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "naming", "the bottom line with the naming sheet up");
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      const after = await stripText(page);
      assertIncludes(after.bottom, "visor settings", "the bottom line with the settings sheet up");
      assert(
        !after.bottom.includes("naming"),
        `the strip still named the evicted sheet: ${JSON.stringify(after.bottom)}`,
      );
    });

    await act("walking to the storage page leaves an open sheet ALONE", async () => {
      // THE CLAIM INVERTED, and strengthened. This act used to assert
      // that opening the storage <dialog> EVICTED whatever lightweight
      // sheet was up — necessary then, because a modal paints in the top
      // layer and would have left a live sheet stranded behind something
      // the user cannot see past. The storage configuration is a sibling
      // PAGE now, under the same pinned strip, so there is nothing to
      // paint over the sheet and no reason to close it: the page changes
      // underneath, the sheet stays, and the strip stays between them.
      assertEquals(await sheetOpen(page, "settings"), true, "the settings sheet before openStorage");
      await hook(page, "openStorage");
      await waitForStoragePage(page, true);
      assertEquals(await sheetOpen(page, "settings"), true, "the settings sheet after openStorage");
      // Not merely "still registered": still SHOWING. A sheet that
      // survived in state while its drawer collapsed would be worse than
      // one that closed honestly.
      assertEquals(
        await page.evaluate(() => (document.getElementById("visor-drawer") as HTMLElement).hidden),
        false,
        "the drawer after walking to the storage page",
      );
      // THE BRACKET IS RESOLVED AT OPEN, NOT CONTINUOUSLY. This sheet
      // was opened at HOME, where a lightweight ceremony dims nothing;
      // walking a place in underneath it does not retroactively bracket
      // it. That is deliberate rather than incidental: the host
      // remembers what `dim` resolved to when the sheet opened so the
      // undo matches the do, and a dim that switched itself on under a
      // sheet already on screen would have no matching moment to switch
      // itself off.
      assertEquals(
        await page.evaluate(() => (document.getElementById("visor-dim") as HTMLElement).hidden),
        true,
        "the visor dim for a sheet the storage page arrived underneath",
      );
    });

    await act("leaving the storage page leaves no panel behind, and the sheet is still the user's", async () => {
      await page.click("#storage-cancel");
      await waitForStoragePage(page, false);
      assertEquals(await sheetOpen(page, "drawer"), false, "a credential sheet after Cancel");
      assertEquals(await sheetOpen(page, "naming"), false, "a naming sheet after Cancel");
      // The settings sheet the previous act left open is STILL open: the
      // user opened it, and only the user closes it.
      assertEquals(await sheetOpen(page, "settings"), true, "the settings sheet after Cancel");
      await hook(page, "settings.cancel");
      await waitForSheet(page, "settings", false);
      await waitForDrawerHidden(page);
      // The context is back on the app: the strip follows the page.
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "TodoMVC", "the surface-name line after leaving the storage page");
    });

    await act("the naming ceremony opens ABOVE the storage page, over a DIMMED and frozen place", async () => {
      // Requested from the strip while the panel's page is up. The modal
      // forced a choice — the sheet or the dialog, never both — so the
      // visor had to retire the panel and take the page back first. Now
      // the sheet unfolds above the strip while the storage page stays
      // exactly where it is: the ceremony is about a SURFACE, not about
      // which page is on screen.
      //
      // WHAT THIS ACT ASSERTS THAT IT DID NOT BEFORE (#22's mid-config
      // clause). "Disturbing nothing" was too weak: a ceremony over a
      // NESTED PLACE leaves a live component underneath it, free to
      // solicit input while the visor's own sheet is on screen — the
      // interleaving the anchor exists to prevent. So the place is now
      // BRACKETED for the ceremony's duration: the visor's dim goes up
      // and the page goes inert. The old claim (page still up, panel
      // still live, sheet open above the strip) is kept in full below
      // and three claims are added on top of it.
      await hook(page, "openStorage");
      await waitForStoragePage(page, true);
      await waitForPanelSurface(page);
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      assertEquals(await onStoragePage(page), true, "the storage page after the ceremony started");
      assertEquals(
        // deno-lint-ignore no-explicit-any
        await page.evaluate(() => (globalThis as any).__demo.boundDestination() !== null),
        true,
        "the panel surface after the ceremony started",
      );
      // ADDED (1): the visor's own dim is up over the place.
      assertEquals(
        await page.evaluate(() => (document.getElementById("visor-dim") as HTMLElement).hidden),
        false,
        "the visor dim while a ceremony is up over the config page",
      );
      // ADDED (2): and the place itself takes no input.
      assertEquals(
        await page.evaluate(() => document.getElementById("page-storage")!.hasAttribute("inert")),
        true,
        "the config page while a ceremony is up over it",
      );
      // ADDED (3): THE PANEL IS STILL LIVE. Inert is not retirement —
      // the component keeps running and keeps its grants, and what it
      // loses is the user's input for as long as the ceremony is up.
      // Retiring it would destroy a configuration session the user is
      // in the middle of and is coming back to.
      assertEquals(
        await page.evaluate(() => document.querySelectorAll("#panel-region iframe").length),
        1,
        "the panel's surface while a ceremony is up over its page",
      );
      // The strip is not covered by any of it: dim sits BELOW the visor
      // zone, which is the whole point of the layering.
      const bracketed = await stripUnobscured(page);
      assertEquals(bracketed.hitInStrip, true, "the strip while the place is dimmed");
      // The strip's back control is up too, and it is REACHABLE with the
      // sheet open: the sheet unfolds ABOVE the strip and the strip stays
      // whole underneath, so the way out of the place is never covered by
      // the ceremony that happens to be on screen.
      const back = await backControl(page);
      assertEquals(back.present, true, "the back control with a sheet open above the storage page");
      assertEquals(back.inStrip, true, "the back control with a sheet open above the storage page");
    });

    await act("the chevron navigates the PAGE and leaves the sheet alone", async () => {
      // THE ORTHOGONALITY RULING, made a gate. Back is about PLACE; a
      // sheet is about a SURFACE and says which one. So clicking back
      // walks the page out from under an open naming sheet without
      // touching it — and the sheet stays truthful, because the name it
      // is collecting is a statement about the component rather than
      // about this visit to its configuration. (The same reason
      // `beforeOpen` no longer exists: see host/demo.ts.)
      assertEquals(await sheetOpen(page, "naming"), true, "the naming sheet before the chevron");
      await page.click("#visor-back");
      await waitForStoragePage(page, false);
      assertEquals(await sheetOpen(page, "naming"), true, "the naming sheet after the chevron");
      // THE EXIT ORDER THE BRACKET HAS TO SURVIVE: the place is LEFT
      // while the ceremony that froze it is still up. The freeze must
      // not follow the user home — the lightweight ceremonies have
      // always left the app alone — and the page that is now off-screen
      // must stay inert for the ordinary reason (a control nobody can
      // see must not be reachable). Both are recomputed rather than
      // undone in pairs, which is what makes every exit order land on
      // the same answer.
      assertEquals(
        await page.evaluate(() => document.getElementById("page-main")!.hasAttribute("inert")),
        false,
        "the main page after walking home under an open ceremony",
      );
      assertEquals(
        await page.evaluate(() => document.getElementById("page-storage")!.hasAttribute("inert")),
        true,
        "the off-screen config page after the chevron",
      );
      assertEquals(
        await page.evaluate(() => (document.getElementById("visor-drawer") as HTMLElement).hidden),
        false,
        "the drawer after the chevron",
      );
      // And the control itself is gone with the place it exited, while
      // the sheet it did not touch is still up.
      assertEquals((await backControl(page)).present, false, "the back control after the chevron");
    });

    let credOpen = false;
    await act("a credential sheet is NEVER displaced — not by naming, not by settings", async () => {
      // SETTLE FIRST. The previous act left a naming sheet up, and its
      // close runs a transition before the drawer goes away; committing
      // on top of that would race the sheet's own teardown. A user
      // cannot click this fast, and the race is not what is under test.
      await hook(page, "naming.cancel");
      await waitForSheet(page, "naming", false);
      await waitForDrawerHidden(page);
      // HOW THE CREDENTIAL SHEET IS REACHED NOW. It used to be the
      // storage page's Save; that button is a config-write since #22
      // ("commitment never leaves the bar"), and the sheet follows the
      // picker's armed SELECTION instead. What this act is about — that
      // an open credential sheet is never displaced — is unchanged, and
      // it is if anything better provoked from here: the sheet now
      // arrives with another visor sheet (the picker) having just held
      // the drawer, so the eviction path is exercised on the way in.
      await hook(page, "picker.open");
      await waitForSheet(page, "picker", true);
      await page.waitForFunction(
        () => document.querySelector(".picker-sheet")?.classList.contains("armed") === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await hook(page, "picker.select", "s3");
      await waitForSheet(page, "drawer", true, 30_000);
      credOpen = true;

      // Both strip gestures, during the arming delay — the exact window
      // in which a baited mis-tap would land.
      await hook(page, "naming.openCluster");
      await hook(page, "settings.openSheet");
      assertEquals(await sheetOpen(page, "drawer"), true, "the credential sheet after strip taps");
      assertEquals(await sheetOpen(page, "naming"), false, "a naming sheet over credentials");
      assertEquals(await sheetOpen(page, "settings"), false, "a settings sheet over credentials");
      // The sheet in the drawer is still the credential one.
      assertEquals(
        await page.evaluate(() =>
          document.querySelectorAll("#visor-drawer-inner .name-sheet, #visor-drawer-inner .settings-sheet")
            .length
        ),
        0,
        "a lightweight sheet displaced the credential sheet",
      );
      // The strip still names the sheet that really owns the drawer.
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "storage credentials", "the bottom line during credential entry");
    });

    await act("the refusal holds AFTER arming too — it is not just the delay", async () => {
      assert(credOpen, "the credential sheet was never opened");
      await page.waitForFunction(
        () =>
          (document.querySelector("#visor-drawer-inner .cred-row button:first-child") as
            | HTMLButtonElement
            | null)?.disabled === false,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await hook(page, "naming.openCluster");
      await hook(page, "settings.openSheet");
      assertEquals(await sheetOpen(page, "drawer"), true, "the armed credential sheet after taps");
      assertEquals(await sheetOpen(page, "naming"), false, "a naming sheet over an armed sheet");
      assertEquals(await sheetOpen(page, "settings"), false, "a settings sheet over an armed sheet");
    });

    await act("cancelling the credential sheet restores the app context", async () => {
      await hook(page, "drawer.cancel");
      await waitForSheet(page, "drawer", false);
      await waitForDrawerHidden(page);
      // The surfaces are live again — the dim is gone with the sheet.
      await page.waitForFunction(
        () => (document.getElementById("visor-dim") as HTMLElement).hidden === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "TodoMVC", "the surface-name line after Cancel");
    });

    await act("and the lightweight sheets work again once the drawer is free", async () => {
      // The refusal was about the CREDENTIAL SESSION, not a latch that
      // stays stuck after it ends.
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      await hook(page, "settings.cancel");
      await waitForSheet(page, "settings", false);
    });
  },
};

export default scenario;
