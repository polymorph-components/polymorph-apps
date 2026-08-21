// The strip says the right things about the app at first sight.
//
// This is the baseline every other visor scenario stands on: with an
// EMPTY trust table, the visor has never seen the app before, so the
// strip's USER line (upstairs) must hold the visor's offer to name it —
// the TOFU marker plus the "name it" control, standing where the user's
// own mark and word will land — while the component's own account of
// itself sits downstairs, quoted and plated in app voice.

import type { Scenario } from "../run.ts";
import { act, appSurface, assert, assertEquals, assertIncludes, frameProbe, stripText } from "../util.ts";

const scenario: Scenario = {
  name: "boot-app-surface",
  why: "a never-seen app boots to NEW + 'name it' on the user's line and its quoted nickname below",
  // No marks seeded: an empty trust table is the whole premise.
  page: {},

  async run(page) {
    await act("the visor registered the app surface with its self-declared nickname", async () => {
      const s = await appSurface(page);
      assert(s !== null, "appSurface() returned null — the visor registered no app surface");
      // `name` is the PROVENANCE key: what the visor fetched the artifact
      // as, which is the one identifier a component cannot choose.
      assertEquals(s.name, "app", "the app's provenance key");
      assertEquals(s.nickname, "TodoMVC", "the app's self-declared nickname");
      assertEquals(s.petname ?? "", "", "a never-seen app has no petname");
      assertEquals(s.isNew, true, "a never-seen app is NEW");
    });

    await act("the bottom line quotes the component's own nickname, and nothing else", async () => {
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "TodoMVC", "the bottom line");
      // The visor's own words never join the component's claim: that line
      // is the component's self-description and only that.
      assert(
        !bottom.includes("NEW") && !bottom.toLowerCase().includes("name it"),
        `the bottom line carried the visor's voice: ${JSON.stringify(bottom)}`,
      );
    });

    await act("the top line carries the visor's TOFU marker and the naming offer", async () => {
      // The user's own line: before there is a petname or a mark to put
      // here, it holds the visor's offer to create them, and the reason
      // to accept — NEW sits beside the offer it motivates.
      const { top } = await stripText(page);
      assertIncludes(top, "NEW", "the top line");
      assertIncludes(top, "first time this component draws here", "the top line");
      const controls = await page.evaluate(() => ({
        fresh: document.querySelectorAll("#visor-context .ctx-top .fresh").length,
        nameIt: document.querySelectorAll("#visor-context .ctx-top #visor-name-it").length,
        // The naming control must be the visor's own pixels IN THE STRIP —
        // never something an app rectangle could have drawn.
        nameItInStrip: document.querySelector("#visor-name-it")?.closest("#visor-strip") !== null,
      }));
      assertEquals(controls.fresh, 1, "the .fresh marker");
      assertEquals(controls.nameIt, 1, "the 'name it' control on .ctx-top");
      assertEquals(controls.nameItInStrip, true, "'name it' lives inside the visor strip");
    });

    await act("the app's surface frame is unreachable from the visor's realm", async () => {
      // The isolation claim the whole strip depends on: if the visor could
      // reach into the app's frame, the app could reach back out.
      const probe = await frameProbe(page);
      assert(probe.appFrames > 0, "no app frames on the page at all");
      assertEquals(probe.sameOriginReachable, false, "a surface frame was same-origin reachable");
    });
  },
};

export default scenario;
