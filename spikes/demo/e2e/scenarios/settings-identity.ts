// The visor's settings sheet: the one interaction with no component in it.
//
// Name, device word, glyph and anchor colour are the second thing an
// impersonating rectangle cannot reproduce (the first being the colour
// itself). They are the USER'S words said in THE VISOR'S voice, so what
// this scenario checks is that the sheet commits exactly what it
// promises — and that a hand-edited record cannot smuggle a glyph
// outside the visor's fixed vocabulary onto the one position that is not
// spoofable.

import type { Scenario } from "../run.ts";
import {
  act,
  assert,
  assertEquals,
  assertIncludes,
  assertList,
  hook,
  identity,
  KEYS,
  sheetText,
  UI_TIMEOUT,
  waitForBoot,
  waitForSheet,
} from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

/** The live anchor colour, read off the STRIP ELEMENT — which is where
 * `applyVisorHue` scopes it, deliberately: on `:root` the property
 * would inherit into every app region, so a component with a style
 * attribute could paint the visor's exact colour without reading it
 * (host/demo.ts `applyVisorHue`, and check-invariants.sh (c)). */
function anchorHue(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.getElementById("visor-strip")!)
      .getPropertyValue("--visor-bg").trim()
  );
}

/** The glyph on the strip's own button. */
function stripIcon(page: Page): Promise<string> {
  return page.evaluate(() =>
    document.getElementById("visor-settings")?.textContent ?? ""
  );
}

function idLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#visor-identity .id-lines .who")).map((e) =>
      e.textContent ?? ""
    )
  );
}

const scenario: Scenario = {
  name: "settings-identity",
  why: "the settings sheet previews live, commits exactly what it shows, reverts on Cancel, and clamps a hand-edited glyph",
  page: {},

  async run(page, ctx) {
    await act("the settings button on the strip opens the visor's own sheet", async () => {
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      const text = await sheetText(page);
      assertIncludes(text, "Your visor", "the sheet's heading");
      assertIncludes(text, "no component is ever told them", "the sheet's lead");
      // The one sheet with NO foreign-quoted text anywhere: there is no
      // component in this interaction at all.
      const foreign = await page.evaluate(() =>
        document.querySelectorAll("#visor-drawer-inner .foreign").length
      );
      assertEquals(foreign, 0, "foreign-quoted text on the settings sheet");
    });

    await act("the strip names the visor's own sheet, and still names the APP upstairs", async () => {
      const strip = await page.evaluate(() => ({
        top: document.querySelector("#visor-context .ctx-top")?.textContent ?? "",
        bottom: document.querySelector("#visor-context .ctx-bottom")?.textContent ?? "",
      }));
      assertIncludes(strip.bottom, "visor settings", "the bottom line");
      // Component identity is a property of what is INSTALLED, not of
      // which visor sheet is open (host/demo.ts `topSurface`).
      assertIncludes(strip.top, "TodoMVC", "the top line while the visor's own sheet is open");
    });

    let previewed = "";
    await act("picking a hue previews it on the ANCHOR immediately", async () => {
      const before = await anchorHue(page);
      // A hue that is certainly not the seeded one.
      await hook(page, "settings.pickHue", 35);
      previewed = await anchorHue(page);
      assert(
        previewed !== before && previewed !== "",
        `the anchor did not repaint on preview (before ${JSON.stringify(before)}, after ${
          JSON.stringify(previewed)
        })`,
      );
      // Nothing is ANNOUNCED for a change the user is in the middle of
      // making (host/demo.ts, the hue button's comment).
      const bottom = await page.evaluate(() =>
        document.querySelector("#visor-context .ctx-bottom")?.textContent ?? ""
      );
      assertIncludes(bottom, "visor settings", "the bottom line during a live preview");
    });

    await act("Cancel drops the typed edits AND puts the previewed colour back", async () => {
      await hook(page, "settings.type", "name", "Discarded");
      await hook(page, "settings.type", "device", "Discarded device");
      await hook(page, "settings.cancel");
      await waitForSheet(page, "settings", false);
      const rec = await identity(page);
      assertEquals(rec.name ?? "", "", "the stored name after Cancel");
      assertEquals(rec.device ?? "", "", "the stored device after Cancel");
      const after = await anchorHue(page);
      assert(
        after !== previewed,
        `Cancel left the previewed colour on the anchor: ${JSON.stringify(after)}`,
      );
      assertList(await idLines(page), [], "the identity cluster after a cancelled sheet");
    });

    await act("Save commits name, device, glyph and colour together", async () => {
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      await hook(page, "settings.type", "name", "Ada");
      await hook(page, "settings.type", "device", "study PC");
      await hook(page, "settings.pickIcon", "⚑");
      await hook(page, "settings.pickHue", 35);
      await hook(page, "settings.save");
      await waitForSheet(page, "settings", false);
      const rec = await identity(page);
      assertEquals(rec.name, "Ada", "the stored name");
      assertEquals(rec.device, "study PC", "the stored device");
      assertEquals(rec.icon, "⚑", "the stored glyph");
      // The strip is repainted FROM THE RECORD, so what the bar shows is
      // exactly what was persisted.
      assertList(await idLines(page), ["Ada", "study PC"], "the identity cluster's two lines");
      assertEquals(await stripIcon(page), "⚑", "the glyph on the strip");
    });

    await act("the committed identity and colour survive a reload", async () => {
      const hueBefore = await anchorHue(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page);
      assertList(await idLines(page), ["Ada", "study PC"], "the identity cluster after a reload");
      assertEquals(await stripIcon(page), "⚑", "the glyph after a reload");
      assertEquals(await anchorHue(page), hueBefore, "the anchor colour after a reload");
    });

    await act("an unset field renders NOTHING — no fabricated 'user'", async () => {
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      await hook(page, "settings.type", "device", "");
      await hook(page, "settings.save");
      await waitForSheet(page, "settings", false);
      // No leftover separator, no placeholder word: one line, the name.
      assertList(await idLines(page), ["Ada"], "the cluster with the device unset");
    });

    await act("a hand-edited glyph outside the visor's vocabulary falls back to ⛨", async () => {
      // The record is localStorage, so it IS hand-editable — that is the
      // threat model here, not a hypothetical. A free-text face could
      // spoof words in the visor's voice at the one position that cannot be
      // spoofed, so the visor renders only from VISOR_ICONS.
      const hostile = await ctx.fresh({
        storage: {
          [KEYS.identity]: JSON.stringify({
            name: "Ada",
            device: "study PC",
            // Not a glyph from the vocabulary: a whole word, which is
            // what an attacker would want on that button.
            icon: "TRUSTED",
          }),
        },
      });
      assertEquals(await stripIcon(hostile), "⛨", "the glyph for an out-of-vocabulary record");
      // And the user's own words are still rendered as data, not markup.
      assertList(await idLines(hostile), ["Ada", "study PC"], "the cluster's lines");
      const injected = await ctx.fresh({
        storage: {
          [KEYS.identity]: JSON.stringify({
            name: "<img src=x onerror=alert(1)>",
            device: "d",
            icon: "⛨",
          }),
        },
      });
      const html = await injected.evaluate(() =>
        document.querySelector("#visor-identity .id-lines .who")?.innerHTML ?? ""
      );
      assert(
        !html.includes("<img"),
        `the record was rendered as markup: ${JSON.stringify(html)}`,
      );
    });

    await act("the anchor colour is never ambient — the app region cannot resolve it", async () => {
      // check-invariants.sh (c) is the SOURCE-level tripwire on this;
      // here it is checked as a live property of the rendered page,
      // which is what actually protects the colour.
      const ambient = await page.evaluate(() => {
        const read = (el: Element | null) =>
          el === null ? "" : getComputedStyle(el).getPropertyValue("--visor-bg").trim();
        return {
          root: read(document.documentElement),
          body: read(document.body),
          // The regions the visor draws components into.
          panes: Array.from(document.querySelectorAll(".pane")).map(read),
        };
      });
      assertEquals(ambient.root, "", "--visor-bg on the document root");
      assertEquals(ambient.body, "", "--visor-bg on the body");
      for (const p of ambient.panes) {
        assertEquals(p, "", "--visor-bg inherited into an app region");
      }
    });

    await act("the settings sheet is reachable ONLY from the visor's own pixels", async () => {
      // The button that opens it lives in the strip, which no component
      // can draw into — the structural half of the claim the sheet makes
      // in words.
      const inStrip = await page.evaluate(() =>
        document.getElementById("visor-settings")?.closest("#visor-strip") !== null
      );
      assertEquals(inStrip, true, "the settings button lives inside the visor strip");
      const inFrame = await page.evaluate(() =>
        document.querySelectorAll("iframe #visor-settings").length
      );
      assertEquals(inFrame, 0, "a settings button inside a component frame");
    });
  },
};

export default scenario;
