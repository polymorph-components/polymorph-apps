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
  hook,
  sheetOpen,
  stripText,
  UI_TIMEOUT,
  waitForDrawerHidden,
  waitForPanelSurface,
  waitForSheet,
} from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

const dialogOpen = (page: Page) =>
  page.evaluate(() =>
    (document.getElementById("storage-dialog") as HTMLDialogElement | null)?.open === true
  );

const waitForDialog = (page: Page, want: boolean) =>
  page.waitForFunction(
    (want: boolean) =>
      ((document.getElementById("storage-dialog") as HTMLDialogElement | null)?.open === true) ===
        want,
    want,
    { timeout: UI_TIMEOUT },
  );

const scenario: Scenario = {
  name: "tenant-precedence",
  why: "the credential sheet is never displaced; the lightweight sheets evict each other; the modal takes the page back first",
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

    await act("opening the storage dialog evicts a lightweight sheet outright", async () => {
      // The dialog is a MODAL in the top layer: it would paint over the
      // sheet rather than replace it, leaving a live sheet stranded
      // behind something the user cannot see past.
      assertEquals(await sheetOpen(page, "settings"), true, "the settings sheet before openStorage");
      await hook(page, "openStorage");
      await waitForDialog(page, true);
      assertEquals(await sheetOpen(page, "settings"), false, "the settings sheet after openStorage");
      assertEquals(await sheetOpen(page, "naming"), false, "the naming sheet after openStorage");
      // The drawer HIDES on a transition rather than instantly (the
      // sheet collapses its height first), so this is a wait, not a
      // sample — the claim is that it ends up away, not that it vanishes
      // within one microtask.
      await waitForDrawerHidden(page);
    });

    await act("cancelling the dialog leaves no sheet and no panel behind", async () => {
      await page.click("#storage-cancel");
      await waitForDialog(page, false);
      assertEquals(await sheetOpen(page, "drawer"), false, "a credential sheet after Cancel");
      assertEquals(await sheetOpen(page, "naming"), false, "a naming sheet after Cancel");
      assertEquals(await sheetOpen(page, "settings"), false, "a settings sheet after Cancel");
      // The context is back on the app: the strip follows the page.
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "TodoMVC", "the surface-name line after the dialog closed");
    });

    await act("the naming ceremony takes the page back BEFORE opening its sheet", async () => {
      // Requested from the strip while the modal is up: the dialog is in
      // the top layer, so the visor retires the panel and closes the dialog
      // first rather than opening a sheet underneath it.
      await hook(page, "openStorage");
      await waitForDialog(page, true);
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      assertEquals(await dialogOpen(page), false, "the dialog after the ceremony started");
    });

    let credOpen = false;
    await act("a credential sheet is NEVER displaced — not by naming, not by settings", async () => {
      // SETTLE FIRST. The previous act left a naming sheet up, and its
      // close runs a transition before the drawer goes away; re-opening
      // the dialog on top of that tears down a panel that is still
      // mounting ("frame backend destroyed before it was ready"). A user
      // cannot click this fast, and the race is not what is under test.
      await hook(page, "naming.cancel");
      await waitForSheet(page, "naming", false);
      await waitForDrawerHidden(page);
      await hook(page, "openStorage");
      await waitForDialog(page, true);
      await waitForPanelSurface(page);
      await page.click("#storage-save");
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
