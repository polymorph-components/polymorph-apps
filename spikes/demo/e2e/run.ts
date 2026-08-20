// End-to-end scenarios for the demo visor, in a REAL Chromium.
//
//   just e2e            (builds the site first, then runs this)
//   deno run -A e2e/run.ts [scenario-name ...]
//
// WHY THIS EXISTS. Every visor and storage flow in this spike has so far
// been driven BY HAND in a browser, once per session, by whoever last
// touched it. That is not a regression test: it is a memory. Worse, the
// hand-driving surface was paseo's embedded webview, which is not a
// reference environment — it eats `<dialog>` close events, forces
// prefers-reduced-motion and cannot see into sandboxed frames, so
// several claims about this visor were literally unverifiable there
// (see scenarios/dialog-close-retirement.ts, which is exactly one of
// them).
//
// So: Playwright driving a real headless Chromium, as a LIBRARY from
// Deno — no @playwright/test, no package.json, no second toolchain. The
// output discipline is the tasks-engine act runner's: sequential acts,
// a loud line per claim, and a non-zero exit if any of them broke.
//
// The harness owns the world the scenarios run in: a static server for
// the built `serve/` directory, a MinIO with CORS open (the credential
// beats need a real S3 to talk to, and one of them needs it DOWN), and
// one browser. Each scenario gets a fresh browser context, so no
// scenario can pass because of something another one left in storage.

import { chromium } from "npm:playwright@1.57.0";
import type { Browser, Page } from "npm:playwright@1.57.0";
import { serveDir } from "jsr:@std/http@1.0.13/file-server";
import { actCount, type Ctx, type FreshOptions, newContext, resetActs, waitForBoot } from "./util.ts";

import bootAppSurface from "./scenarios/boot-app-surface.ts";
import petnameCeremony from "./scenarios/petname-ceremony.ts";
import settingsIdentity from "./scenarios/settings-identity.ts";
import stripGeometry from "./scenarios/strip-geometry.ts";
import credentialFlow from "./scenarios/credential-flow.ts";
import transportRefusal from "./scenarios/transport-refusal.ts";
import tenantPrecedence from "./scenarios/tenant-precedence.ts";
import dialogCloseRetirement from "./scenarios/dialog-close-retirement.ts";
import stripOwnership from "./scenarios/strip-ownership.ts";

// Re-exported so a scenario imports its whole contract from one place:
// `Scenario` and the `Ctx` it is handed.
export type { Ctx, FreshOptions };

export interface Scenario {
  /** Selector name, and what the summary calls it. */
  name: string;
  /** One line: the claim the whole scenario is making. */
  why: string;
  /** Options for the page the runner opens and boots for this scenario.
   * A function when the seed depends on the world — MinIO's port is
   * ephemeral, so a stored storage config can only be written once the
   * harness knows it. */
  page?: FreshOptions | ((ctx: Ctx) => FreshOptions);
  /** Whether the store must be reachable. `down` stops MinIO for the
   * duration and brings it back afterwards. */
  minio?: "up" | "down";
  run(page: Page, ctx: Ctx): Promise<void>;
}

const SCENARIOS: Scenario[] = [
  bootAppSurface,
  petnameCeremony,
  settingsIdentity,
  stripGeometry,
  // The credential beats come before the refusal beat: one needs the
  // store up, the next needs it down, and a scenario that has to bring
  // infrastructure back is cheaper than one that has to configure it.
  credentialFlow,
  transportRefusal,
  tenantPrecedence,
  dialogCloseRetirement,
  // Last: it provokes the visor-timer races, so it is the scenario most
  // likely to leave a page in an interesting state — and it gets a fresh
  // context either way.
  stripOwnership,
];

const here = new URL(".", import.meta.url).pathname;
const demoRoot = new URL("../", import.meta.url).pathname;

// --- the static site -------------------------------------------------------

async function freePort(): Promise<number> {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return await Promise.resolve(port);
}

function serveSite(root: string, port: number): Deno.HttpServer {
  return Deno.serve({
    port,
    hostname: "127.0.0.1",
    onListen: () => {},
  }, (req) =>
    serveDir(req, {
      fsRoot: root,
      quiet: true,
      // REQUIRED, not a convenience. The surface frame is sandboxed
      // WITHOUT `allow-same-origin`, so its origin is opaque ("null") —
      // and a script fetch from an opaque origin is a cross-origin
      // request. Without these headers frame.js is blocked and the demo
      // wedges at "mounting apps…". `just serve` gets this from the
      // file-server CLI, which sends them by default; serveDir does not.
      enableCors: true,
      // A missing artifact must be a 404 the page reports rather than a
      // directory listing it tries to instantiate.
      showDirListing: false,
    }));
}

// --- MinIO -----------------------------------------------------------------

const MINIO_BIN = `${demoRoot}../tasks-engine/.deps/minio`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";

class Minio {
  #proc: Deno.ChildProcess | null = null;
  #data: string | null = null;
  readonly url: string;
  readonly #port: number;

  constructor(port: number) {
    this.#port = port;
    this.url = `http://127.0.0.1:${port}`;
  }

  async start(): Promise<void> {
    if (this.#proc) return;
    // A FRESH data directory per run: a previous run's buckets, grants
    // and revoked pickup objects must never be what makes a beat pass.
    this.#data ??= await Deno.makeTempDir({ prefix: "pm-e2e-minio." });
    this.#proc = new Deno.Command(MINIO_BIN, {
      args: ["server", this.#data, "--address", `127.0.0.1:${this.#port}`, "--quiet"],
      env: {
        MINIO_ROOT_USER: MINIO_USER,
        MINIO_ROOT_PASSWORD: MINIO_PASS,
        // Chrome will not let the page's fetch reach the store without
        // it; the demo's own `just infra` sets exactly this.
        MINIO_API_CORS_ALLOW_ORIGIN: "*",
      },
      stdout: "null",
      stderr: "null",
    }).spawn();
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`${this.url}/minio/health/live`);
        await r.body?.cancel();
        if (r.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("minio never became healthy");
  }

  async stop(): Promise<void> {
    if (!this.#proc) return;
    const proc = this.#proc;
    this.#proc = null;
    try {
      proc.kill("SIGKILL");
    } catch { /* already dead */ }
    await proc.status;
    // The port must actually be refusing connections before a scenario
    // asserts on a transport failure — otherwise it races the socket.
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`${this.url}/minio/health/live`);
        await r.body?.cancel();
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("minio kept answering after being killed");
  }

  async dispose(): Promise<void> {
    await this.stop();
    if (this.#data) await Deno.remove(this.#data, { recursive: true }).catch(() => {});
  }
}

// --- the run ---------------------------------------------------------------

async function main() {
  const wanted = Deno.args.filter((a) => !a.startsWith("-"));
  const headed = Deno.args.includes("--headed");
  const site = `${demoRoot}serve`;
  try {
    await Deno.stat(`${site}/index.html`);
  } catch {
    console.error(`no built site at ${site} — run \`just site\` first (\`just e2e\` does).`);
    Deno.exit(2);
  }

  const sitePort = await freePort();
  const server = serveSite(site, sitePort);
  const baseUrl = `http://127.0.0.1:${sitePort}`;
  const minio = new Minio(await freePort());
  await minio.start();

  // The browser comes from playwright's own cache — `~/.cache/ms-playwright`
  // by default, or wherever PLAYWRIGHT_BROWSERS_PATH points (CI sets it to
  // a cacheable directory keyed on the pinned version; see
  // .github/workflows/e2e.yml). `just e2e-deps` is what guarantees it is
  // there, by PROBING a launch and only downloading if that fails.
  const browser: Browser = await chromium.launch({
    headless: !headed,
    // The demo runs entirely against 127.0.0.1 and instantiates a large
    // wasm graph; the sandbox is off for the same reason cdp-heap.ts
    // turns it off (containerised CI without user namespaces), and
    // /dev/shm is small in the same containers.
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const openPages: Page[] = [];
  const ctx: Ctx = {
    baseUrl,
    browser,
    minioUrl: minio.url,
    minioAccess: MINIO_USER,
    minioSecret: MINIO_PASS,
    stopMinio: () => minio.stop(),
    startMinio: () => minio.start(),
    fresh: async (opts: FreshOptions = {}) => {
      const bctx = await newContext(browser, opts);
      const page = await bctx.newPage();
      openPages.push(page);
      // Console noise is kept, not printed: a failing act dumps it, a
      // passing one would drown the summary.
      const lines: string[] = [];
      page.on("console", (m) => lines.push(`[${m.type()}] ${m.text()}`));
      page.on("pageerror", (e) => lines.push(`[pageerror] ${e.message}`));
      (page as unknown as { __log: string[] }).__log = lines;
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      if (!opts.noWait) await waitForBoot(page);
      return page;
    },
  };

  const results: { name: string; ok: boolean; ms: number; acts: number; error?: string }[] = [];
  const runList = wanted.length > 0
    ? SCENARIOS.filter((s) => wanted.includes(s.name))
    : SCENARIOS;
  if (wanted.length > 0 && runList.length !== wanted.length) {
    console.error(`unknown scenario(s): ${wanted.filter((w) => !SCENARIOS.some((s) => s.name === w))}`);
    Deno.exit(2);
  }

  console.log(`\ne2e: ${runList.length} scenario(s) against ${baseUrl}\n`);
  const started = performance.now();

  for (const scenario of runList) {
    console.log(`  ── ${scenario.name}: ${scenario.why}`);
    resetActs();
    const t0 = performance.now();
    let page: Page | null = null;
    try {
      if (scenario.minio === "down") await minio.stop();
      else await minio.start();
      page = await ctx.fresh(
        typeof scenario.page === "function" ? scenario.page(ctx) : scenario.page,
      );
      await scenario.run(page, ctx);
      results.push({
        name: scenario.name,
        ok: true,
        ms: Math.round(performance.now() - t0),
        acts: actCount().acts,
      });
    } catch (e) {
      // The log is read off whatever pages the scenario opened —
      // including one that failed to BOOT, which is the case where the
      // console is the only evidence there is.
      const log = openPages.flatMap((p) => (p as unknown as { __log: string[] }).__log ?? []);
      if (log.length > 0) {
        console.log("         --- page console (last 15) ---");
        for (const l of log.slice(-15)) console.log(`         ${l}`);
      }
      results.push({
        name: scenario.name,
        ok: false,
        ms: Math.round(performance.now() - t0),
        acts: actCount().acts,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // Every scenario's contexts go away with it: isolation is the
      // harness's job, not the scenario's.
      for (const p of openPages.splice(0)) {
        await p.context().close().catch(() => {});
      }
    }
    console.log("");
  }

  await browser.close();
  await minio.dispose();
  await server.shutdown();

  const wall = ((performance.now() - started) / 1000).toFixed(1);
  const failed = results.filter((r) => !r.ok);
  console.log("  ════ summary ════");
  for (const r of results) {
    console.log(
      `  ${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(26)} ${String(r.acts).padStart(2)} acts  ${
        (r.ms / 1000).toFixed(1)
      }s${r.error ? `  — ${r.error}` : ""}`,
    );
  }
  console.log(
    `\n  ${results.length - failed.length}/${results.length} scenarios passed in ${wall}s\n`,
  );
  Deno.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.main) await main();
export { here };
