// The naming ceremony, end to end: the TOFU moment completing.
//
// This is the scenario the whole visor exists for. A component says
// what it is; the visor says what the USER decided it is — and once the
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
  iconOffers,
  marks,
  namingReason,
  nominationLine,
  sheetText,
  sleep,
  stripMarkIcon,
  stripText,
  UI_TIMEOUT,
  waitForBoot,
  waitForBottom,
  waitForSheet,
  waitForStoragePage,
} from "../util.ts";

const PETNAME = "tasks board";

/** WHAT THE GUESTS ASK TO WEAR (spikes/demo/wit/todomvc.wit's
 * `mark-nomination`, implemented in each guest's lib.rs). Pinned here
 * because the whole nomination path is only testable against a component
 * that actually nominates something: the app asks for the chess rook,
 * the S3 panel for the alembic, and the Dropbox panel asks for NOTHING —
 * which is the case that proves `none` is a first-class answer rather
 * than a code path nobody runs. */
const APP_NOMINATION = "\u265C"; // ♜ U+265C BLACK CHESS ROOK
const S3_NOMINATION = "\u2697"; // ⚗ U+2697 ALEMBIC

const scenario: Scenario = {
  name: "petname-ceremony",
  why: "naming a component from the strip retires NEW, speaks in the visor's voice, persists, and refuses collisions",
  page: {},

  async run(page, ctx) {
    await act("the whole left cluster is a tap target that opens App settings", async () => {
      // The cluster — not just the small control inside it — is the
      // gesture: visor pixels in the strip, which no component can draw.
      const tappable = await page.evaluate(() => {
        const el = document.getElementById("visor-context");
        return { role: el?.getAttribute("role"), tabindex: el?.getAttribute("tabindex") };
      });
      assertEquals(tappable.role, "button", "the cluster's role");
      assertEquals(tappable.tabindex, "0", "the cluster's tabindex");
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
    });

    await act("the sheet is the visor's App settings, in the visor's own words", async () => {
      const text = await sheetText(page);
      assertIncludes(text, "App settings", "the sheet's heading");
      // The two voices that are not the user's, both named as such.
      assertIncludes(text, "calls itself", "the sheet");
      assertIncludes(text, "visor fetched it as", "the sheet");
      // The visor's own memory of the component — the one line that answers
      // "have I really seen this before?" with something but a colour.
      assertIncludes(text, "first seen", "the sheet");
      assertIncludes(text, "TodoMVC", "the sheet quotes the self-declared nickname");
      // And the standing claim about whose pixels these are.
      assertIncludes(text, "a component cannot draw here", "the sheet's note");
    });

    await act("the ceremony offers SIX pet icons, none of them a colour", async () => {
      // THE DESIGN CHANGE (#22 discussion): the recognition-COLOUR picker
      // is gone, and with it the chip the strip used to draw. What
      // replaced it is a mark the user can NAME — "the little rook" —
      // out of a curated vocabulary. Six offers: enough to be a choice,
      // few enough to scan.
      const offers = await iconOffers(page);
      assertEquals(offers.length, 6, "the number of pet-icon offers");
      const glyphs = offers.map((o) => o.glyph);
      assertEquals(new Set(glyphs).size, 6, "the offers are distinct");
      for (const g of glyphs) {
        assertEquals([...g].length, 1, `the offer ${JSON.stringify(g)} is one scalar`);
      }
      // No swatch row survives anywhere on the sheet, and no chip.
      const dead = await page.evaluate(() => ({
        swatches: document.querySelectorAll(".name-sheet .name-swatches").length,
        chips: document.querySelectorAll("#visor-drawer-inner .chip").length,
      }));
      assertEquals(dead.swatches, 0, "leftover colour swatches on the naming sheet");
      assertEquals(dead.chips, 0, "leftover mark chips on the naming sheet");
    });

    await act("the app's own NOMINATION is offered first, in the component's voice", async () => {
      // A component may ASK to wear a glyph. The visor offers it — FIRST,
      // so the user sees it — but never in the visor's own voice: the
      // sentence is the visor's, the glyph is quoted as the component's,
      // exactly like a nickname. Adoption is the user's act.
      const offers = await iconOffers(page);
      assertEquals(offers[0].glyph, APP_NOMINATION, "the first offer");
      assertEquals(offers[0].nominated, true, "the first offer is flagged as the component's");
      assertEquals(
        offers.filter((o) => o.nominated).length,
        1,
        "exactly one offer is the component's",
      );
      const line = await nominationLine(page);
      assertIncludes(line, "it asks to wear", "the foreign attribution line");
      assertIncludes(line, APP_NOMINATION, "the attribution line shows the nominated glyph");
      assertIncludes(line, "the rest are the visor's own", "the attribution line");
      // The strip is still bare: nominating is not wearing. Nothing the
      // component said has reached the anchor.
      assertEquals(await stripMarkIcon(page), "", "the strip's mark before the user picks one");
    });

    await act("an unmarked surface shows NO glyph, and none is picked for the user", async () => {
      const offers = await iconOffers(page);
      assertEquals(
        offers.filter((o) => o.picked).length,
        0,
        "a preselected mark on a surface the user has never marked",
      );
      const s = await appSurface(page);
      assertEquals(s?.icon, "", "the app surface's icon before the ceremony");
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

    await act(`saving "${PETNAME}" with the ADOPTED nomination announces it`, async () => {
      await hook(page, "naming.type", PETNAME);
      // ADOPTION: the user takes the glyph the component asked for. From
      // this point it is the USER's mark — the visor speaks it on the
      // anchor — and the component is never told that it happened.
      const adopted = await hook(page, "naming.adoptNomination");
      assertEquals(adopted, APP_NOMINATION, "the glyph the adoption gesture picked");
      await hook(page, "naming.save");
      await waitForSheet(page, "naming", false);
      // The announcement is the visor speaking about its own trust table —
      // asserted BEFORE the revert, because it is a timed line.
      const said = await waitForBottom(
        page,
        (t) => t.includes("the visor will call this component"),
        "the naming announcement",
      );
      assertIncludes(said, PETNAME, "the announcement");
    });

    await act("the petname is in the trust table and on the live surface", async () => {
      const s = await appSurface(page);
      assertEquals(s?.petname, PETNAME, "the live app surface's petname");
      assertEquals(s?.icon, APP_NOMINATION, "the adopted pet icon on the live surface");
      // THE #22 FIX: first sight is over. The ceremony IS the TOFU
      // moment completing (host/demo.ts:2695).
      assertEquals(s?.isNew, false, "isNew after the naming ceremony");
      const table = await marks(page) as Record<string, { petname?: string; icon?: string }>;
      assertEquals(table["app"]?.petname, PETNAME, "the persisted petname for the app record");
      assertEquals(table["app"]?.icon, APP_NOMINATION, "the persisted pet icon");
    });

    await act("the adopted mark is now on the STRIP, beside the user's own word", async () => {
      assertEquals(await stripMarkIcon(page), APP_NOMINATION, "the strip's pet icon");
      // And it is TEXT in the visor's own foreground, not a painted
      // swatch: the chip element is gone from the strip entirely.
      const chips = await page.evaluate(() =>
        document.querySelectorAll("#visor-context .chip").length
      );
      assertEquals(chips, 0, "leftover mark chips on the strip");
    });

    await act("after the announcement reverts, the strip speaks the petname and NOT 'NEW'", async () => {
      // A SLEEP, deliberately: the thing under test IS the timer. The
      // announcement holds the line for 8s (host/demo.ts `announce`
      // default) and then reverts BY RE-RENDERING, which is the only way
      // the line can be honest about a table that changed underneath it.
      await sleep(ANNOUNCE_MS + 500);
      const { top, bottom } = await stripText(page);
      assertIncludes(top, PETNAME, "the reverted user line");
      // The demotion: the user's own word is the FIRST line, beside the
      // mark they picked; the component's own account of itself sits
      // below it as a quote.
      assertIncludes(bottom, "TodoMVC", "the bottom line still quotes the nickname");
      const dom = await page.evaluate(() => ({
        fresh: document.querySelectorAll("#visor-context .ctx-top .fresh").length,
        nameIt: document.querySelectorAll("#visor-name-it").length,
        petname: document.querySelectorAll("#visor-context .ctx-top .petname").length,
      }));
      // The regression this scenario exists to catch: a re-render that
      // reads a stale isNew would put NEW back beside the petname.
      assertEquals(dom.fresh, 0, ".fresh must be ABSENT once the component has been named");
      assertEquals(dom.nameIt, 0, "the 'name it' offer once there is a name");
      assertEquals(dom.petname, 1, "the petname on the user's line");
      assert(
        !top.includes("NEW"),
        `the user's line still said NEW: ${JSON.stringify(top)}`,
      );
    });

    await act("the petname survives a reload, still without NEW", async () => {
      // Same browser context: this beat is ABOUT continuing state.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page);
      const s = await appSurface(page);
      assertEquals(s?.petname, PETNAME, "the petname after a reload");
      assertEquals(s?.icon, APP_NOMINATION, "the pet icon after a reload");
      assertEquals(s?.isNew, false, "a component with a stored mark is not NEW again");
      assertEquals(await stripMarkIcon(page), APP_NOMINATION, "the strip's pet icon after a reload");
      const { top } = await stripText(page);
      assertIncludes(top, PETNAME, "the user's line after a reload");
      assertEquals(
        await page.evaluate(() =>
          document.querySelectorAll("#visor-context .ctx-top .fresh").length
        ),
        0,
        ".fresh after a reload",
      );
    });

    await act("a SECOND component cannot be given the same word", async () => {
      // The collision is only meaningful across two records, so the s3
      // panel is named first — through the storage page, which is the
      // only place that surface exists.
      await hook(page, "openStorage");
      await waitForStoragePage(page, true);
      // Wait for the panel surface to be registered before naming it:
      // `openFor` is provenance-keyed and opens NOTHING for a key the visor
      // does not already hold (host/demo.ts, `naming.openFor`).
      await page.waitForFunction(
        // deno-lint-ignore no-explicit-any
        () => (globalThis as any).__demo.naming.openFor("panel-s3") === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await waitForSheet(page, "naming", true);

      // THE PANEL'S OWN NOMINATION, offered first and attributed to it —
      // and the app's adopted mark is NOT among the offers, because
      // local uniqueness is the whole point of assigning marks from the
      // unused set. A component asking for a glyph another record wears
      // is refused in SILENCE: no error, no mention, nothing the app can
      // detect.
      const panelOffers = await iconOffers(page);
      assertEquals(panelOffers.length, 6, "the panel's pet-icon offers");
      assertEquals(panelOffers[0].glyph, S3_NOMINATION, "the panel's first offer");
      assertEquals(panelOffers[0].nominated, true, "the panel's first offer is its own request");
      assert(
        !panelOffers.some((o) => o.glyph === APP_NOMINATION),
        `a glyph another record already wears was offered: ${JSON.stringify(panelOffers)}`,
      );
      assertIncludes(await nominationLine(page), "it asks to wear", "the panel's attribution line");
      await hook(page, "naming.pickIcon", S3_NOMINATION);
      await hook(page, "naming.type", "s3 config");
      await hook(page, "naming.save");
      await waitForSheet(page, "naming", false);
      const afterPanel = await marks(page) as Record<string, { icon?: string }>;
      assertEquals(afterPanel["panel-s3"]?.icon, S3_NOMINATION, "the panel's adopted mark");

      // Now try to give the APP the panel's word — which means walking
      // back to the app's page first. The strip's cluster is about the
      // surface the user is looking at, and while the storage page is up
      // that is the PANEL: naming from the cluster here would re-open the
      // panel's own ceremony, not the app's.
      //
      // THIS STEP USED TO BE INVISIBLE. The sheets' `beforeOpen` hook
      // tore the panel down and closed the storage <dialog> before any
      // sheet could open — a modal would otherwise have painted over it —
      // so "open the ceremony" silently meant "and leave the panel". A
      // sibling page needs no eviction, so the walk back is a gesture the
      // scenario makes for itself, as the user would.
      await page.click("#storage-cancel");
      await waitForStoragePage(page, false);
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      await hook(page, "naming.type", "s3 config");
      await hook(page, "naming.save");
      const reason = await namingReason(page);
      assertIncludes(reason, "you already call another component", "the collision refusal");
      // The visor names the colliding record by BOTH its petname and its
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

    await act("a component that nominates NOTHING gets six visor offers and no attribution", async () => {
      // The Dropbox panel returns `none` (guest-panel-dropbox/src/lib.rs).
      // The ceremony must look exactly the same minus the foreign line —
      // "no preference" is a first-class answer, not a degraded one.
      //
      // The naming sheet the previous act left open is closed first: this
      // act is about the panel's ceremony, not about evicting one.
      await hook(page, "naming.cancel");
      await waitForSheet(page, "naming", false);
      await hook(page, "openStorage");
      await waitForStoragePage(page, true);
      await page.click("#prov-dropbox");
      await page.waitForFunction(
        // deno-lint-ignore no-explicit-any
        () => (globalThis as any).__demo.naming.openFor("panel-dropbox") === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await waitForSheet(page, "naming", true);
      const offers = await iconOffers(page);
      assertEquals(offers.length, 6, "the offers for a component with no nomination");
      assertEquals(
        offers.filter((o) => o.nominated).length,
        0,
        "a nominated offer for a component that nominated nothing",
      );
      assertEquals(await nominationLine(page), "", "the attribution line with no nomination");
      // Local uniqueness holds across all three records.
      assert(
        !offers.some((o) => o.glyph === APP_NOMINATION || o.glyph === S3_NOMINATION),
        `a claimed glyph was offered: ${JSON.stringify(offers.map((o) => o.glyph))}`,
      );
      await hook(page, "naming.cancel");
      await waitForSheet(page, "naming", false);
    });

    await act("forgetting drops the name AND the mark, and promises NEW next time", async () => {
      // Re-opened on the APP: the previous act took the ceremony to the
      // Dropbox panel and closed it, so the sheet this one forgets from
      // is opened here rather than inherited.
      //
      // LEAVING THE STORAGE PAGE IS EXPLICIT NOW. It used to happen as a
      // side effect: the sheets' `beforeOpen` hook took the page back
      // from the modal <dialog> before any sheet could open, because a
      // modal would have painted over it. A sibling page needs no such
      // eviction — a sheet opens above the strip while the storage page
      // sits where it is (tenant-precedence.ts asserts exactly that) —
      // so this act, which is about the APP's record, walks back itself.
      await page.click("#storage-cancel");
      await waitForStoragePage(page, false);
      await hook(page, "naming.openFor", "app");
      await waitForSheet(page, "naming", true);
      // Arm the announcement watcher BEFORE triggering the forget — the
      // honest observation order, and the one that caught a real bug: the
      // panel this act just left behind retires on a
      // DEFERRED restore, which used to land milliseconds after the forget
      // announcement and clobber it (CI run 32442122042; visor.ts's
      // sameContext is the fix). Armed-late only ever passed by winning
      // that race.
      const announced = waitForBottom(
        page,
        (t) => t.includes("forgotten"),
        "the forget announcement",
      );
      await hook(page, "naming.forget");
      await waitForSheet(page, "naming", false);
      const said = await announced;
      assertIncludes(said, "announced as NEW next time", "the forget announcement");
      const table = await marks(page) as Record<string, unknown>;
      assertEquals(table["app"], undefined, "the app's record after forgetting");
      const s = await appSurface(page);
      assertEquals(s?.petname ?? "", "", "the live surface's petname after forgetting");
      // Forgetting is honest about BOTH halves: the mark goes with the
      // name, so the strip stops wearing a glyph the visor no longer
      // holds a record for.
      assertEquals(await stripMarkIcon(page), "", "the strip's mark after forgetting");
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
      const { top } = await stripText(next);
      assertIncludes(top, "NEW", "the user's line for a forgotten component");
    });
  },
};

export default scenario;
