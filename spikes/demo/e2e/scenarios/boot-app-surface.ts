// The strip says the right things about the app at first sight.
//
// This is the baseline every other visor scenario stands on: with an
// EMPTY trust table, the visor has never seen the app before, so the strip
// must show the component's own account of itself upstairs (quoted,
// foreign) and, in the visor's voice downstairs, the TOFU marker plus the
// offer to give it a name of the user's own.

import type { Scenario } from "../run.ts";
import { act, appSurface, assert, assertEquals, assertIncludes, frameProbe, stripText } from "../util.ts";

const scenario: Scenario = {
  name: "boot-app-surface",
  why: "a never-seen app boots to a quoted nickname upstairs and NEW + 'name it' in the visor's voice",
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

    await act("the top line quotes the component's own nickname, and nothing else", async () => {
      const { top } = await stripText(page);
      assertIncludes(top, "TodoMVC", "the top line");
      // The visor's own words never appear upstairs: that line is the
      // component's identity and only that.
      assert(
        !top.includes("NEW") && !top.toLowerCase().includes("name it"),
        `the top line carried the visor's voice: ${JSON.stringify(top)}`,
      );
    });

    await act("the bottom line carries the visor's TOFU marker and the naming offer", async () => {
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "NEW", "the bottom line");
      assertIncludes(bottom, "first time this component draws here", "the bottom line");
      const controls = await page.evaluate(() => ({
        fresh: document.querySelectorAll("#visor-context .ctx-bottom .fresh").length,
        nameIt: document.querySelectorAll("#visor-context .ctx-bottom #visor-name-it").length,
        // The naming control must be the visor's own pixels IN THE STRIP —
        // never something an app rectangle could have drawn.
        nameItInStrip: document.querySelector("#visor-name-it")?.closest("#visor-strip") !== null,
      }));
      assertEquals(controls.fresh, 1, "the .fresh marker");
      assertEquals(controls.nameIt, 1, "the 'name it' control on .ctx-bottom");
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
