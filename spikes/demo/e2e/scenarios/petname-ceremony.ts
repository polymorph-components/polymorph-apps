// The naming ceremony, end to end: the TOFU moment completing.
//
// This is the scenario the whole chrome exists for. A component says
// what it is; chrome says what the USER decided it is — and once the
// user has decided, the "NEW" badge is retired, because "first time this
// component draws here" and "you call this one tasks board" are
// contradictory claims to make side by side (host/demo.ts:2695-2701).
//
// Every beat here was previously hand-driven once per session. Two of
// them are the #22 fixes that a hand-drive is least likely to re-check:
// the isNew-cleared rule above, and the collision refusal.

import type { Scenario } from "../run.ts";
import {
  act,
  ANNOUNCE_MS,
  appSurface,
  assert,
  assertEquals,
  assertIncludes,
  hook,
  marks,
  namingReason,
  sheetText,
  sleep,
  stripText,
  UI_TIMEOUT,
  waitForBoot,
  waitForBottom,
  waitForSheet,
} from "../util.ts";

const PETNAME = "tasks board";

const scenario: Scenario = {
  name: "petname-ceremony",
  why: "naming a component from the strip retires NEW, speaks in chrome's voice, persists, and refuses collisions",
  page: {},

  async run(page, ctx) {
    await act("the whole left cluster is a tap target that opens App settings", async () => {
      // The cluster — not just the small control inside it — is the
      // gesture: chrome pixels in the strip, which no component can draw.
      const tappable = await page.evaluate(() => {
        const el = document.getElementById("chrome-context");
        return { role: el?.getAttribute("role"), tabindex: el?.getAttribute("tabindex") };
      });
      assertEquals(tappable.role, "button", "the cluster's role");
      assertEquals(tappable.tabindex, "0", "the cluster's tabindex");
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
    });

    await act("the sheet is chrome's App settings, in chrome's own words", async () => {
      const text = await sheetText(page);
      assertIncludes(text, "App settings", "the sheet's heading");
      // The two voices that are not the user's, both named as such.
      assertIncludes(text, "calls itself", "the sheet");
      assertIncludes(text, "chrome fetched it as", "the sheet");
      // Chrome's own memory of the component — the one line that answers
      // "have I really seen this before?" with something but a colour.
      assertIncludes(text, "first seen", "the sheet");
      assertIncludes(text, "TodoMVC", "the sheet quotes the self-declared nickname");
      // And the standing claim about whose pixels these are.
      assertIncludes(text, "a component cannot draw here", "the sheet's note");
    });

    await act("the strip names the open sheet while it is up", async () => {
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "naming", "the bottom line while the naming sheet is open");
    });

    await act("an empty name is REFUSED, not treated as 'forget'", async () => {
      await hook(page, "naming.type", "   ");
      await hook(page, "naming.save");
      // Still open: a refusal leaves the ceremony where it was.
      assertEquals(await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.naming.open()
      ), true, "the sheet after an empty save");
      assertIncludes(
        await namingReason(page),
        "type a name, or Cancel",
        "the refusal line",
      );
      const s = await appSurface(page);
      assertEquals(s?.petname ?? "", "", "the petname after a refused save");
    });

    await act(`saving "${PETNAME}" announces it in chrome's voice`, async () => {
      await hook(page, "naming.type", PETNAME);
      await hook(page, "naming.save");
      await waitForSheet(page, "naming", false);
      // The announcement is chrome speaking about its own trust table —
      // asserted BEFORE the revert, because it is a timed line.
      const said = await waitForBottom(
        page,
        (t) => t.includes("chrome will call this component"),
        "the naming announcement",
      );
      assertIncludes(said, PETNAME, "the announcement");
    });

    await act("the petname is in the trust table and on the live surface", async () => {
      const s = await appSurface(page);
      assertEquals(s?.petname, PETNAME, "the live app surface's petname");
      // THE #22 FIX: first sight is over. The ceremony IS the TOFU
      // moment completing (host/demo.ts:2695).
      assertEquals(s?.isNew, false, "isNew after the naming ceremony");
      const table = await marks(page) as Record<string, { petname?: string }>;
      assertEquals(table["app"]?.petname, PETNAME, "the persisted petname for the app record");
    });

    await act("after the announcement reverts, the strip speaks the petname and NOT 'NEW'", async () => {
      // A SLEEP, deliberately: the thing under test IS the timer. The
      // announcement holds the line for 8s (host/demo.ts `announce`
      // default) and then reverts BY RE-RENDERING, which is the only way
      // the line can be honest about a table that changed underneath it.
      await sleep(ANNOUNCE_MS + 500);
      const { top, bottom } = await stripText(page);
      assertIncludes(bottom, PETNAME, "the reverted bottom line");
      // The demotion: the component's own account of itself stays
      // UPSTAIRS as a quote; chrome's line is the user's word.
      assertIncludes(top, "TodoMVC", "the top line still quotes the nickname");
      const dom = await page.evaluate(() => ({
        fresh: document.querySelectorAll("#chrome-context .ctx-bottom .fresh").length,
        nameIt: document.querySelectorAll("#chrome-name-it").length,
        petname: document.querySelectorAll("#chrome-context .ctx-bottom .petname").length,
      }));
      // The regression this scenario exists to catch: a re-render that
      // reads a stale isNew would put NEW back beside the petname.
      assertEquals(dom.fresh, 0, ".fresh must be ABSENT once the component has been named");
      assertEquals(dom.nameIt, 0, "the 'name it' offer once there is a name");
      assertEquals(dom.petname, 1, "the petname on chrome's line");
      assert(
        !bottom.includes("NEW"),
        `the bottom line still said NEW: ${JSON.stringify(bottom)}`,
      );
    });

    await act("the petname survives a reload, still without NEW", async () => {
      // Same browser context: this beat is ABOUT continuing state.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page);
      const s = await appSurface(page);
      assertEquals(s?.petname, PETNAME, "the petname after a reload");
      assertEquals(s?.isNew, false, "a component with a stored mark is not NEW again");
      const { bottom } = await stripText(page);
      assertIncludes(bottom, PETNAME, "the bottom line after a reload");
      assertEquals(
        await page.evaluate(() =>
          document.querySelectorAll("#chrome-context .ctx-bottom .fresh").length
        ),
        0,
        ".fresh after a reload",
      );
    });

    await act("a SECOND component cannot be given the same word", async () => {
      // The collision is only meaningful across two records, so the s3
      // panel is named first — through the storage dialog, which is the
      // only place that surface exists.
      await hook(page, "openStorage");
      await page.waitForFunction(
        () => (document.getElementById("storage-dialog") as HTMLDialogElement)?.open === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      // Wait for the panel surface to be registered before naming it:
      // `openFor` is provenance-keyed and opens NOTHING for a key chrome
      // does not already hold (host/demo.ts, `naming.openFor`).
      await page.waitForFunction(
        // deno-lint-ignore no-explicit-any
        () => (globalThis as any).__demo.naming.openFor("panel-s3") === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await waitForSheet(page, "naming", true);
      await hook(page, "naming.type", "s3 config");
      await hook(page, "naming.save");
      await waitForSheet(page, "naming", false);

      // Now try to give the APP the panel's word.
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      await hook(page, "naming.type", "s3 config");
      await hook(page, "naming.save");
      const reason = await namingReason(page);
      assertIncludes(reason, "you already call another component", "the collision refusal");
      // Chrome names the colliding record by BOTH its petname and its
      // unforgeable provenance key: the user needs to know which
      // component already answers to this word.
      assertIncludes(reason, "s3 config", "the collision refusal names the petname");
      assertIncludes(reason, "panel-s3", "the collision refusal names the provenance key");
      assertEquals(await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.naming.open()
      ), true, "the sheet stays open on a refused collision");
      const s = await appSurface(page);
      assertEquals(s?.petname, PETNAME, "a refused collision leaves the old petname alone");
    });

    await act("forgetting drops the name and promises NEW next time", async () => {
      // The sheet is still open on the app, showing the refusal.
      await hook(page, "naming.forget");
      await waitForSheet(page, "naming", false);
      const said = await waitForBottom(
        page,
        (t) => t.includes("forgotten"),
        "the forget announcement",
      );
      assertIncludes(said, "announced as NEW next time", "the forget announcement");
      const table = await marks(page) as Record<string, unknown>;
      assertEquals(table["app"], undefined, "the app's record after forgetting");
      const s = await appSurface(page);
      assertEquals(s?.petname ?? "", "", "the live surface's petname after forgetting");
    });

    await act("a fresh context sees the forgotten component as NEW again", async () => {
      // Forgetting deleted the record, so the NEXT mount is honestly
      // new — the claim the announcement just made, checked rather than
      // trusted. A reload of THIS page would do, but a fresh context
      // proves it is the storage that carries it.
      const stored = await page.evaluate(() => localStorage.getItem("pm-demo-surface-marks"));
      const next = await ctx.fresh({
        storage: stored ? { "pm-demo-surface-marks": stored } : {},
      });
      const s = await appSurface(next);
      assertEquals(s?.isNew, true, "isNew for a component whose record was forgotten");
      const { bottom } = await stripText(next);
      assertIncludes(bottom, "NEW", "the bottom line for a forgotten component");
    });
  },
};

export default scenario;
