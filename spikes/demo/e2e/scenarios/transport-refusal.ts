// A store that cannot be reached must FAIL, in words, and never trap.
//
// The regression this exists for (#33): a transport error crossing the
// component boundary used to surface as a WebAssembly TRAP — the guest
// aborting rather than returning an error. A trapped instance is a dead
// instance: the pane stops, and the user is told nothing useful about a
// condition that is both ordinary and recoverable (the store is down,
// the endpoint is wrong, CORS is misconfigured).
//
// So the claim has two halves, and BOTH matter:
//   - the failure is REPORTED, naming the request that failed and the
//     fact that it was retried;
//   - the word "Trap:" appears nowhere on the page or in the console.
//
// A hand-drive checks the first half and forgets the second.

import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertIncludes, KEYS, waitForPaneStatus } from "../util.ts";

const BUCKET = "pm-demo";

const scenario: Scenario = {
  name: "transport-refusal",
  why: "an unreachable store fails with the visor's own words and never as a trap (#33)",
  // The store is DOWN for this whole scenario: that is the premise.
  minio: "down",
  page: (ctx: Ctx) => ({
    storage: {
      [KEYS.storage]: JSON.stringify({
        provider: "s3",
        // The port MinIO would be on — now refusing connections.
        endpoint: ctx.minioUrl,
        bucket: BUCKET,
        access: ctx.minioAccess,
        secret: ctx.minioSecret,
      }),
    },
  }),

  async run(page) {
    await act("the demo still BOOTS with an unreachable store", async () => {
      // Storage is optional for boot, and a dead store must not take the
      // page with it — the two other replicas are unaffected.
      const banner = await page.evaluate(() =>
        document.getElementById("banner")?.textContent ?? ""
      );
      assertIncludes(banner, "ready", "the banner with an unreachable store");
    });

    await act("the tablet reports the transport failure in the visor's own words", async () => {
      // Sticky, so it stays put; the retries take a moment.
      const status = await waitForPaneStatus(
        page,
        "tablet",
        (t) => t.includes("transport failed after"),
        "the transport failure",
        90_000,
      );
      // The exact shape #33 settled on: the engine names the REQUEST, the
      // attempt count says it was retried rather than given up on, and
      // the transport layer is named as the thing that failed.
      assertIncludes(status, "transport failed after 3 attempts", "the failure line");
      assertIncludes(status, "store-owner-fetch:", "the failure names the request");
      assertIncludes(status, "transport:", "the failure names the transport layer");
      // And it stays actionable: the user is told what to check.
      assertIncludes(status, "storage setup failed at", "the failure names the step");
    });

    await act("the word 'Trap:' appears NOWHERE on the page", async () => {
      // The whole rendered document, not just the pane that failed: a
      // trap surfacing in any status line, banner or sheet is the same
      // regression.
      const body = await page.evaluate(() => document.body.innerText);
      assert(
        !body.includes("Trap:"),
        `"Trap:" was rendered on the page: ${
          JSON.stringify(body.split("\n").find((l) => l.includes("Trap:")))
        }`,
      );
      // `unreachable` is what a trapped guest reports underneath; catching
      // it here too keeps the check honest if the label is ever reworded.
      assert(
        !/wasm.*unreachable|unreachable executed/i.test(body),
        "a wasm trap was rendered on the page",
      );
    });

    await act("no trap reached the console either", async () => {
      // deno-lint-ignore no-explicit-any
      const log = ((page as any).__log ?? []) as string[];
      const trapped = log.filter((l) =>
        l.includes("Trap:") || /unreachable executed/i.test(l)
      );
      assert(
        trapped.length === 0,
        `a trap was logged: ${JSON.stringify(trapped.slice(0, 3))}`,
      );
    });

    await act("the replicas that do not need the store are still alive", async () => {
      // The point of the refusal being an ERROR rather than a trap: the
      // rest of the page keeps working.
      const alive = await page.evaluate(async () => {
        // deno-lint-ignore no-explicit-any
        const d = (globalThis as any).__demo;
        const stats = await d.alice.engine.driver.stats();
        return typeof stats === "string" && stats.length > 0;
      });
      assert(alive, "alice's engine was dead after the store failed");
      // And the bucket-gated controls stayed OFF rather than pretending.
      const gated = await page.evaluate(() =>
        (document.getElementById("bucket-sync") as HTMLButtonElement).disabled
      );
      assert(gated, "the bucket controls were enabled despite a failed setup");
    });
  },
};

export default scenario;
