// The end-to-end TodoMVC demo (#20): three panes, one page.
//
//   alice   — the engine + app, wire hub, bucket owner
//   bob     — a collaborator over the live iroh websocket relay
//   tablet  — Alice's second device; NO connections, bucket only
//
// Each pane is TWO component instances under deltic: the engine
// composite (keyhive + automerge + subduction + bridge + SigV4 bucket
// client + iroh endpoint) and the todomvc app guest. The app's
// `polymorph-data:tasks` import is wired DIRECTLY to the engine
// instance's export — the framework-links-apps-to-services topology.

import { artifactsFromEnvelope, instantiate } from "@deltic/runtime/embedder";
import { createBackend, createRunner, type Runner } from "../../todomvc/host/app.ts";
import { createSurface } from "../../todomvc/host/surface.ts";
import type { UiEvent } from "../../todomvc/host/events.ts";
import {
  type Driver,
  type Engine,
  type EngineArtifacts,
  newEngine,
  unhex,
  until,
} from "./engine.ts";

// The live path rides n0's PUBLIC relay by default (interop proven in
// polymorph-iroh's `just interop-prod`); override with ?relay=… — e.g.
// a local `iroh-relay --dev` at http://127.0.0.1:3340.
const params = new URLSearchParams(location.search);
const RELAY = params.get("relay") ?? "https://use1-1.relay.n0.iroh.link";

// The bucket (non-realtime path + the tablet pane) is USER-CONFIGURED:
// any S3-compatible endpoint whose CORS admits this origin. Stored in
// localStorage; query params (?s3=&bucket=&access=&secret=) pre-seed it.
interface S3Config {
  endpoint: string;
  bucket: string;
  access: string;
  secret: string;
}

const S3_KEY = "pm-demo-s3";

function loadS3(): S3Config | null {
  if (params.get("s3")) {
    return {
      endpoint: params.get("s3")!,
      bucket: params.get("bucket") ?? "pm-demo",
      access: params.get("access") ?? "",
      secret: params.get("secret") ?? "",
    };
  }
  try {
    const raw = localStorage.getItem(S3_KEY);
    return raw ? JSON.parse(raw) as S3Config : null;
  } catch {
    return null;
  }
}

const INFRA_HELP = `the live path needs the relay to be reachable (default: n0's public
relay; ?relay=… to override). The bucket pane is configured via the
Storage… dialog and is optional for boot.`;

// --- artifacts -----------------------------------------------------------------

async function fetchArtifacts(name: string): Promise<EngineArtifacts> {
  const [envelope, bytes] = await Promise.all([
    fetch(`./${name}.plan.json`).then((r) => {
      if (!r.ok) throw new Error(`${name} plan: HTTP ${r.status}`);
      return r.text();
    }),
    fetch(`./${name}.component.wasm`).then((r) => {
      if (!r.ok) throw new Error(`${name} wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return { envelope, bytes: new Uint8Array(bytes) };
}

// --- panes ---------------------------------------------------------------------

interface AppExports {
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  onRoute(route: string): Promise<void>;
  poll(): Promise<boolean>;
}

interface Pane {
  name: string;
  engine: Engine;
  id: Uint8Array;
  runner?: Runner;
  app?: AppExports;
  status: (line: string) => void;
}

function statusLine(name: string): (line: string) => void {
  const div = document.getElementById(`${name}-status`)!;
  return (line) => {
    div.textContent = line;
  };
}

async function newPane(
  name: string,
  engineArtifacts: EngineArtifacts,
): Promise<Pane> {
  const engine = await newEngine(name, engineArtifacts);
  const status = statusLine(name);
  status("engine up");
  return { name, engine, id: new Uint8Array(), status };
}

/** Instantiate the app guest over a pane's engine (call once the pane's
 * partition is bound: the app renders the service's answers). */
async function mountApp(pane: Pane, appArtifacts: EngineArtifacts) {
  const container = document.getElementById(`${pane.name}-app`)!;
  let dispatch: (ev: UiEvent) => void = () => {};
  const backend = createBackend("direct", container as HTMLElement, (ev) => dispatch(ev));
  const surface = createSurface(backend, () => "");
  const imports = {
    ...surface.imports,
    // The framework seam: the app's data-service import IS the engine
    // instance's export object (same embedder, same value conventions,
    // same exception brand).
    "polymorph-data:tasks/tasks@0.1.0": pane.engine.tasks,
  };
  const instance = await instantiate(
    artifactsFromEnvelope(appArtifacts.envelope, appArtifacts.bytes),
    imports,
  );
  const app = instance.exports as unknown as AppExports;
  const runner = createRunner(surface);
  dispatch = (ev) => {
    runner.call(() => app.onEvent(ev)).catch((e) => pane.status(`event: ${e}`));
  };
  await runner.call(() => app.run());
  pane.app = app;
  pane.runner = runner;
  // Remote changes surface as revision bumps; poll on a UI cadence.
  setInterval(() => {
    runner.call(() => app.poll()).catch(() => {});
  }, 400);
}

// --- boot choreography -----------------------------------------------------------

function err(e: unknown): string {
  const p = (e as { payload?: unknown }).payload;
  return typeof p === "string" ? p : String(e);
}

async function boot() {
  const banner = document.getElementById("banner")!;
  const say = (s: string) => {
    banner.textContent = s;
    console.log(`[boot] ${s}`);
  };

  say("fetching artifacts…");
  const [engineArt, appArt] = await Promise.all([
    fetchArtifacts("engine"),
    fetchArtifacts("app"),
  ]);

  say("instantiating engines…");
  const alice = await newPane("alice", engineArt);
  const bob = await newPane("bob", engineArt);
  const tablet = await newPane("tablet", engineArt);
  const panes = [alice, bob, tablet];

  say("identities…");
  for (const p of panes) {
    p.id = unhex(await p.engine.driver.init(false));
    p.status(`id ${Array.from(p.id.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("")}…`);
  }

  // Tablet enrollment cards are pasted (it has no wire).
  await alice.engine.driver.khIngestContact(await tablet.engine.driver.khContactCard());
  await tablet.engine.driver.khIngestContact(await alice.engine.driver.khContactCard());

  say("wire: alice ⇄ bob over the relay…");
  await alice.engine.driver.irohBind(RELAY);
  const bobEp = unhex(await bob.engine.driver.irohBind(RELAY));
  const cb = await bob.engine.driver.irohStart(false, new Uint8Array(), RELAY, new Uint8Array());
  const ca = await alice.engine.driver.irohStart(true, bobEp, RELAY, bob.id);
  await until("handshake", async () =>
    (await alice.engine.driver.connStatus(ca)) && (await bob.engine.driver.connStatus(cb)));
  await until("contact cards", () => alice.engine.driver.khKnowsAgent(bob.id));

  say("partition: create → members → seal…");
  const part = await alice.engine.driver.createPartition();
  await alice.engine.driver.khAddMember(part, bob.id, "edit");
  await alice.engine.driver.khAddMember(part, tablet.id, "edit");
  await alice.engine.driver.sealPartition(part);
  await bob.engine.driver.adoptPartition(part);
  await tablet.engine.driver.adoptPartition(part);

  say("first sync…");
  await until("bob knows the doc", () => bob.engine.driver.khKnowsAgent(part));
  const pull = async (e: Engine, from: Uint8Array) => {
    const h = await e.driver.syncStart(from, part, false);
    return await until("pull", () => e.driver.syncStatus(h));
  };
  await pull(bob.engine, alice.id);
  await until("bob decrypts", async () => (await bob.engine.tasks.revision()) >= 1n);
  const hs = await bob.engine.driver.syncStart(alice.id, part, true);
  await until("bob subscribe", () => bob.engine.driver.syncStatus(hs));
  await pull(alice.engine, bob.id);
  const ha = await alice.engine.driver.syncStart(bob.id, part, true);
  await until("alice subscribe", () => alice.engine.driver.syncStatus(ha));

  say("mounting apps…");
  for (const p of panes) await mountApp(p, appArt);

  // All background engine work rides ONE chain: never concurrent with
  // itself (a wedged overlap of interval-driven driver calls froze the
  // page once; recorded).
  let bg: Promise<unknown> = Promise.resolve();
  const enqueue = (f: () => Promise<unknown>) => {
    const next = bg.then(f).catch(() => {});
    bg = next;
    return next;
  };

  // --- controls -------------------------------------------------------------

  // Subscriptions carry the realtime path; a background reconciliation
  // pull bounds any missed push (one in-browser push miss was observed;
  // recorded as a finding).
  setInterval(() => {
    enqueue(() => pull(bob.engine, alice.id));
    enqueue(() => pull(alice.engine, bob.id));
  }, 2500);

  // --- the bucket leg: user-configured, activates the tablet ---------------

  let bucketReady = false;
  const syncBtn = document.getElementById("bucket-sync") as HTMLButtonElement;
  const autoBox = document.getElementById("bucket-auto") as HTMLInputElement;
  syncBtn.disabled = true;
  autoBox.disabled = true;
  tablet.status("no storage configured — use Storage… to activate this pane");

  const setupBucket = (cfg: S3Config) =>
    enqueue(async () => {
      try {
        tablet.status("configuring storage…");
        await alice.engine.driver.initStore(cfg.endpoint, cfg.bucket, cfg.access, cfg.secret);
        await tablet.engine.driver.initStore(cfg.endpoint, cfg.bucket, cfg.access, cfg.secret);
        await alice.engine.driver.ensureBucket();
        for (const m of [alice.id, bob.id, tablet.id]) {
          await alice.engine.driver.storeGrant(part, m);
        }
        await alice.engine.driver.bucketFlush(part);
        tablet.status(await tablet.engine.driver.bucketPull(part, alice.id));
        bucketReady = true;
        syncBtn.disabled = false;
        autoBox.disabled = false;
      } catch (e) {
        tablet.status(`storage setup failed: ${err(e)} — check endpoint + CORS`);
      }
    });

  const bucketSync = () =>
    enqueue(async () => {
      if (!bucketReady) return;
      try {
        await alice.engine.driver.bucketFlush(part);
        await tablet.engine.driver.bucketFlush(part);
        tablet.status(await tablet.engine.driver.bucketPull(part, alice.id));
        alice.status(await alice.engine.driver.bucketPull(part, alice.id));
      } catch (e) {
        tablet.status(`bucket: ${err(e)}`);
      }
    });
  syncBtn.onclick = () => {
    bucketSync();
  };
  setInterval(() => {
    if (autoBox.checked) bucketSync();
  }, 4000);

  // The storage dialog: prefill from stored config (or local-MinIO
  // defaults), persist on save, run setup once.
  const dialog = document.getElementById("s3-dialog") as HTMLDialogElement;
  const field = (id: string) => document.getElementById(id) as HTMLInputElement;
  (document.getElementById("s3-open") as HTMLButtonElement).onclick = () => {
    const cur = loadS3() ?? {
      endpoint: "http://127.0.0.1:9000",
      bucket: "pm-demo",
      access: "minioadmin",
      secret: "minioadmin",
    };
    field("s3-endpoint").value = cur.endpoint;
    field("s3-bucket").value = cur.bucket;
    field("s3-access").value = cur.access;
    field("s3-secret").value = cur.secret;
    dialog.showModal();
  };
  (document.getElementById("s3-save") as HTMLButtonElement).onclick = (ev) => {
    ev.preventDefault();
    const cfg: S3Config = {
      endpoint: field("s3-endpoint").value.trim().replace(/\/$/, ""),
      bucket: field("s3-bucket").value.trim(),
      access: field("s3-access").value,
      secret: field("s3-secret").value,
    };
    localStorage.setItem(S3_KEY, JSON.stringify(cfg));
    dialog.close();
    if (bucketReady) {
      tablet.status("storage changed — reload the page to reconfigure");
    } else {
      setupBucket(cfg);
    }
  };
  (document.getElementById("s3-cancel") as HTMLButtonElement).onclick = (ev) => {
    ev.preventDefault();
    dialog.close();
  };

  const stored = loadS3();
  if (stored) setupBucket(stored);

  (document.getElementById("revoke-bob") as HTMLButtonElement).onclick = () => {
    enqueue(async () => {
      try {
        await alice.engine.driver.khRevokeMember(part, bob.id);
        await alice.engine.driver.storeRevoke(part, bob.id);
        await alice.engine.driver.bucketFlush(part);
        bob.status("REVOKED: new epochs are dark from here");
        (document.getElementById("bob-pane") as HTMLElement).classList.add("revoked");
      } catch (e) {
        alice.status(`revoke: ${err(e)}`);
      }
    });
  };

  // Live stats footer per pane (the tablet keeps its setup hint until
  // storage is configured).
  setInterval(() => {
    enqueue(async () => {
      for (const p of panes) {
        if (p === tablet && !bucketReady) continue;
        try {
          p.status(await p.engine.driver.stats());
        } catch { /* pane dead */ }
      }
    });
  }, 4000);

  // Debug/validation handles (the paseo browser driver uses these).
  (globalThis as unknown as Record<string, unknown>).__demo = { alice, bob, tablet, part, pull };
  say("ready — E2E-encrypted, three replicas, two sync paths");
}

boot().catch((e) => {
  console.error(e);
  const banner = document.getElementById("banner")!;
  banner.textContent = `boot failed: ${err(e)}`;
  const help = document.createElement("pre");
  help.style.cssText = "margin:.5em 0 0; font-size:11px; color:#f5c16c; white-space:pre-wrap";
  help.textContent = INFRA_HELP;
  banner.appendChild(help);
});
