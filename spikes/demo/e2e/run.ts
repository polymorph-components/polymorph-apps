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
import devicePairing from "./scenarios/device-pairing.ts";

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
  // The two pairing ceremonies. It runs against the in-page mock driver
  // (see the scenario's own header for why, and PAIRING.md §6), so it
  // needs no relay and no store.
  devicePairing,
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
        // Bounded: a fetch that SYN-hangs would otherwise wedge start()
        // forever — every harness wait must have a deadline.
        const r = await fetch(`${this.url}/minio/health/live`, {
          signal: AbortSignal.timeout(2_000),
        });
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
        const r = await fetch(`${this.url}/minio/health/live`, {
          signal: AbortSignal.timeout(2_000),
        });
        await r.body?.cancel();
      } catch (e) {
        // Connection refused is the state this loop exists to reach. A
        // TIMEOUT is not refusal — the port answered nothing either way,
        // and a scenario asserting on transport refusal must not be told
        // the socket is closed while a slow server still holds it.
        if (e instanceof DOMException && e.name === "TimeoutError") continue;
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
  const launchBrowser = () =>
    chromium.launch({
      headless: !headed,
      // The demo runs entirely against 127.0.0.1 and instantiates a large
      // wasm graph; the sandbox is off for the same reason cdp-heap.ts
      // turns it off (containerised CI without user namespaces), and
      // /dev/shm is small in the same containers.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  let browser: Browser = await launchBrowser();

  const openPages: Page[] = [];
  // Phase tracing for the deadline diagnostics: every await between a
  // scenario banner and its first act sets the phase it is entering, so
  // a deadline failure can NAME the wedged call instead of leaving a
  // silent banner (the two observed CI wedges both died namelessly).
  let phase = "idle";
  let phaseAt = performance.now();
  const setPhase = (p: string) => {
    phase = p;
    phaseAt = performance.now();
  };
  const ctx: Ctx = {
    baseUrl,
    // A getter, not a copy: the runner replaces a wedged browser (see the
    // deadline machinery below), and a scenario must always see the live
    // one.
    get browser() {
      return browser;
    },
    minioUrl: minio.url,
    minioAccess: MINIO_USER,
    minioSecret: MINIO_PASS,
    stopMinio: () => minio.stop(),
    startMinio: () => minio.start(),
    fresh: async (opts: FreshOptions = {}) => {
      setPhase("newContext");
      const bctx = await newContext(browser, opts);
      setPhase("newPage");
      const page = await bctx.newPage();
      openPages.push(page);
      // Console noise is kept, not printed: a failing act dumps it, a
      // passing one would drown the summary.
      const lines: string[] = [];
      page.on("console", (m) => lines.push(`[${m.type()}] ${m.text()}`));
      page.on("pageerror", (e) => lines.push(`[pageerror] ${e.message}`));
      (page as unknown as { __log: string[] }).__log = lines;
      setPhase("goto");
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      if (!opts.noWait) {
        setPhase("waitForBoot");
        await waitForBoot(page);
      }
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

  // --- the scenario deadline --------------------------------------------
  //
  // Every wait INSIDE the harness is bounded (BOOT_TIMEOUT, UI_TIMEOUT,
  // minio's health loops) — but Playwright PROTOCOL calls are not:
  // newContext/newPage against a wedged chrome-headless-shell simply
  // never return. Observed twice in CI (2026-08-21): a run hung at a
  // scenario banner — after the previous scenario, before the first
  // act — for 56 minutes until the JOB timeout killed it, with the
  // headless shell still alive among the orphans. The deadline turns
  // that hour of silence into a labeled failure in minutes; a
  // deadline-shaped failure also RELAUNCHES the browser, because a
  // wedged one stays wedged and would eat every following scenario too.
  const SCENARIO_DEADLINE_MS = 240_000; // > BOOT_TIMEOUT + slowest scenario
  const DEADLINE_MARK = "scenario deadline";
  const withDeadline = <T>(p: Promise<T>): Promise<T> => {
    let timer: number | undefined;
    const bomb = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${DEADLINE_MARK}: no progress in ${SCENARIO_DEADLINE_MS / 1000}s ` +
                `(a hang below the harness's own bounded waits — a wedged ` +
                `browser protocol call is the known cause)`,
            ),
          ),
        SCENARIO_DEADLINE_MS,
      );
    });
    return Promise.race([p, bomb]).finally(() => clearTimeout(timer)) as Promise<T>;
  };
  /** Bounded close-and-relaunch for a browser presumed wedged: close()
   * itself is a protocol call and can hang, so it races a short fuse
   * and the old process is abandoned to the OS if it does. */
  const recoverBrowser = async () => {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    browser = await launchBrowser();
    console.log("         (browser relaunched after a deadline failure)");
  };

  for (const scenario of runList) {
    console.log(`  ── ${scenario.name}: ${scenario.why}`);
    resetActs();
    const t0 = performance.now();
    let page: Page | null = null;
    try {
      await withDeadline((async () => {
        setPhase("minio");
        if (scenario.minio === "down") await minio.stop();
        else await minio.start();
        page = await ctx.fresh(
          typeof scenario.page === "function" ? scenario.page(ctx) : scenario.page,
        );
        setPhase("scenario");
        await scenario.run(page, ctx);
        setPhase("idle");
      })());
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
      if (e instanceof Error && e.message.startsWith(DEADLINE_MARK)) {
        // The diagnostics the two silent CI wedges lacked: WHERE it was
        // stuck, whether the protocol was alive at all, and whether the
        // runner was starved for memory (an OOM-killed browser child
        // manifests as exactly this kind of silence).
        const stuck = ((performance.now() - phaseAt) / 1000).toFixed(1);
        console.log(`         wedged in phase '${phase}' for ${stuck}s`);
        console.log(`         browser.isConnected(): ${browser.isConnected()}`);
        if (Deno.build.os === "linux") {
          try {
            const mem = new TextDecoder().decode(
              (await new Deno.Command("free", { args: ["-m"] }).output()).stdout,
            );
            for (const l of mem.trim().split("\n")) console.log(`         ${l}`);
          } catch { /* diagnostics are best-effort */ }
        }
        await recoverBrowser();
      }
    } finally {
      // Every scenario's contexts go away with it: isolation is the
      // harness's job, not the scenario's. Bounded for the same reason
      // as recoverBrowser: close() on a wedged browser never returns.
      for (const p of openPages.splice(0)) {
        await Promise.race([
          p.context().close().catch(() => {}),
          new Promise((r) => setTimeout(r, 5_000)),
        ]);
      }
    }
    console.log("");
  }

  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
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
