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

import {
  artifactsFromEnvelope,
  ComponentException,
  instantiate,
} from "@deltic/runtime/embedder";
import { createRunner, type Runner } from "../../todomvc/host/app.ts";
import { createFrameBackend } from "./frame-backend.ts";
import { createSurface } from "../../todomvc/host/surface.ts";
import type { UiEvent } from "../../todomvc/host/events.ts";
import {
  type Driver,
  type Engine,
  type EngineArtifacts,
  newEngine,
  type StoreConfig,
  unhex,
  until,
} from "./engine.ts";

// The live path rides n0's PUBLIC relay by default (interop proven in
// polymorph-iroh's `just interop-prod`); override with ?relay=… — e.g.
// a local `iroh-relay --dev` at http://127.0.0.1:3340.
const params = new URLSearchParams(location.search);
const RELAY = params.get("relay") ?? "https://use1-1.relay.n0.iroh.link";

// --- the OAuth redirect landing (chrome-owned; #22 × #7) ------------------------
//
// The provider redirects the popup back to THIS page with ?code=&state=.
// That window's only job is to relay the code to the opener and go away:
// it must not boot a second demo (three more engines, a second wire).
// Navigation and redirect handling are chrome capabilities — the panel
// never sees this at all.
const relayedCode = params.get("code");
const isAuthPopup = !!relayedCode && !!window.opener;
if (isAuthPopup) {
  window.opener.postMessage(
    { pmDropboxCode: relayedCode, state: params.get("state") },
    location.origin,
  );
  const el = document.getElementById("banner");
  if (el) el.textContent = "authorization relayed — close this window";
  window.close();
}

// The bucket (non-realtime path + the tablet pane) is USER-CONFIGURED,
// per provider. Stored in localStorage; the s3 query params
// (?s3=&bucket=&access=&secret=) still pre-seed an S3 config.
type StorageConfig =
  | { provider: "s3"; endpoint: string; bucket: string; access: string; secret: string }
  | {
    provider: "dropbox";
    appKey: string;
    appSecret: string;
    accessToken: string;
    refreshToken: string;
    root: string;
  };

const STORAGE_KEY = "pm-demo-storage";

// --- chrome appearance: the personal, undisclosed anchor -----------------------
//
// The strip's colour is the user's own: RANDOMISED on first run, pickable
// from a constrained palette, and never handed to app code. It is a
// SECONDARY anchor — position is the primary one (apps cannot paint the
// strip at all) — and it is deliberately NOT the dropped #22
// personalization secret: it demands no user action at a decision point
// and no per-prompt verification, so it fails toward "something looks
// off" rather than "I forgot to check".
//
// Why the palette is constrained: fixed lightness and chroma in OKLCH
// means every choice keeps the same text contrast, so the anchor can
// never be customised into an unreadable or a look-alike state.
//
// Why apps cannot learn it: nothing in the surface API carries a colour;
// the app rectangle is opaque so chrome pixels and app pixels never
// composite (blend/backdrop-filter pixel-stealing has nothing to
// sample); and the framework's curated DOM must additionally withhold
// blend modes, backdrop filters, CSSOM read-back and system-colour
// keywords — see the #5 ruling table. The demo enforces the structural
// half: this value is never passed to a guest, and the component tint
// below is derived from component bytes instead.
const CHROME_HUES = [265, 210, 175, 140, 95, 60, 35, 10, 330, 300];
const CHROME_KEY = "pm-demo-chrome-hue";

function chromeHue(): { hue: number; fresh: boolean } {
  try {
    const raw = localStorage.getItem(CHROME_KEY);
    if (raw !== null) {
      const hue = Number(raw);
      if (CHROME_HUES.includes(hue)) return { hue, fresh: false };
    }
  } catch { /* storage unavailable: fall through to a fresh pick */ }
  // First run (or eviction). A silently-reset anchor would train users
  // that "chrome colour changes sometimes", which inverts the training —
  // so a reset is ANNOUNCED, never quiet. In the framework this value
  // belongs with durable device state (#11's identity bundle).
  const hue = CHROME_HUES[Math.floor(Math.random() * CHROME_HUES.length)];
  try {
    localStorage.setItem(CHROME_KEY, String(hue));
  } catch { /* nothing durable to write to */ }
  return { hue, fresh: true };
}

function applyChromeHue(hue: number) {
  // Scoped to the strip ELEMENT, never to :root. A custom property on the
  // document root is ambient authority: it inherits into every app
  // region, so a component that ever gained a `style` attribute (or a
  // chrome class resolving var(--chrome-bg)) could paint chrome's exact
  // colour without ever reading it. Keeping the value out of scope makes
  // the secrecy structural instead of a property of the allowlist.
  const strip = document.getElementById("chrome-strip");
  if (!strip) return;
  strip.style.setProperty("--chrome-bg", `oklch(38% .07 ${hue})`);
  strip.style.setProperty("--chrome-fg", "#f4f6fc");
}

// Surface marks: the recognition colour chrome shows for a component is
// ASSIGNED at first sight and stored in a trust record — never derived.
//
// Two derivations died here, both to the same attack: making CHROME'S
// OWN STRIP vouch the wrong colour. Deriving from component bytes let an
// impersonator grind its artifact until the strip assigned it the
// target's colour (and reshuffled every legitimate update). Deriving
// from HMAC(user-secret, name) fixed the grind only to reopen it
// through the other input: names are self-declared, so declaring the
// target's name yields the target's colour. Any copyable-pixel colour is
// trivially fakeable INSIDE an attacker's rectangle; the strip is the
// only place it means anything, so what renders there must not be a
// function of anything an attacker chooses.
//
// Assignment also buys the property no derivation can: LOCAL
// UNIQUENESS. Hues are handed out from the unused set, so two trust
// records on this device never share a mark while the palette lasts
// (past that, colours stop distinguishing and the framework needs
// shapes/patterns — recorded, not solved).
//
// The record key must be unforgeable PROVENANCE, never self-declared
// identity — a name that can look up someone else's record is the same
// attack through the table. Here the key is the artifact name AS
// FETCHED BY CHROME from its own origin (chrome-verified provenance in
// this demo); when signed releases and publisher identity land (#3,
// #10), it becomes the publisher's verifying key. Durability follows
// the chrome-hue story: these live with device state (#11), and a lost
// table means reassignment — visible, so it must be announced, never
// silent.
const MARKS_KEY = "pm-demo-surface-marks";

interface SurfaceMark {
  hue: number;
  firstSeen: number;
}

function surfaceMark(provenance: string): { mark: SurfaceMark; isNew: boolean } {
  let table: Record<string, SurfaceMark> = {};
  try {
    table = JSON.parse(localStorage.getItem(MARKS_KEY) ?? "{}");
  } catch { /* treat as empty */ }
  const existing = table[provenance];
  if (existing) return { mark: existing, isNew: false };
  const used = new Set(Object.values(table).map((m) => m.hue));
  const free = CHROME_HUES.filter((h) => !used.has(h));
  const pool = free.length > 0 ? free : CHROME_HUES;
  const hue = pool[Math.floor(Math.random() * pool.length)];
  const mark = { hue, firstSeen: Date.now() };
  table[provenance] = mark;
  try {
    localStorage.setItem(MARKS_KEY, JSON.stringify(table));
  } catch { /* nothing durable to write to */ }
  return { mark, isNew: true };
}

/** Pre-provider-split key; read once as an S3 config so a configured
 * browser keeps working across the rework. */
const LEGACY_S3_KEY = "pm-demo-s3";

function loadStorage(): StorageConfig | null {
  if (params.get("s3")) {
    return {
      provider: "s3",
      endpoint: params.get("s3")!,
      bucket: params.get("bucket") ?? "pm-demo",
      access: params.get("access") ?? "",
      secret: params.get("secret") ?? "",
    };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as StorageConfig;
    const legacy = localStorage.getItem(LEGACY_S3_KEY);
    if (legacy) {
      const s3 = JSON.parse(legacy) as {
        endpoint: string;
        bucket: string;
        access: string;
        secret: string;
      };
      return { provider: "s3", ...s3 };
    }
    return null;
  } catch {
    return null;
  }
}

const INFRA_HELP = `the live path needs the relay to be reachable (default: n0's public
relay; ?relay=… to override). The bucket pane is configured via the
Storage… dialog and is optional for boot.`;

// --- artifacts -----------------------------------------------------------------

/** Build stamp from the page's tiny mutable root; artifacts carry it so a
 * cached bundle can never be paired with fresh components (or vice
 * versa). Empty in a dev tree that skipped the rewrite. */
const BUILD =
  (document.querySelector('meta[name="pm-build"]') as HTMLMetaElement | null)
    ?.content ?? "";
const stamp = (path: string) => (BUILD && BUILD !== "__BUILD__" ? `${path}?v=${BUILD}` : path);

async function fetchArtifacts(name: string): Promise<EngineArtifacts> {
  const [envelope, bytes] = await Promise.all([
    fetch(stamp(`./${name}.plan.json`)).then((r) => {
      if (!r.ok) throw new Error(`${name} plan: HTTP ${r.status}`);
      return r.text();
    }),
    fetch(stamp(`./${name}.component.wasm`)).then((r) => {
      if (!r.ok) throw new Error(`${name} wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return { envelope, bytes: new Uint8Array(bytes) };
}

// --- chrome capabilities the panels do NOT have -------------------------------

/** `throw new ComponentException(payload)` is the err side of a
 * `result<_, string>` (embedder-api §"Error model"; same brand the
 * webcrypto/websocket ports use). An UNBRANDED throw would trap the
 * panel instead of letting it render the refusal. */
function witErr(message: string): never {
  throw new ComponentException(message);
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const AUTH_TIMEOUT_MS = 5 * 60_000;

/** Chrome's credential store for the live dialog session. Installed by
 * the dialog wiring in `boot`; module-level so the broker and the scoped
 * fetch shim (both chrome capabilities defined out here) can deposit and
 * read WITHOUT the values ever passing through a panel. Per-session: the
 * dialog's teardown clears them. */
let depositCredential: (kind: string, value: string) => void = () => {};
let heldCredential: (kind: string) => string = () => "";
/** The destination chrome's held credentials are BOUND to: a normalized
 * origin, or null while there is none. Module-level for the same reason
 * the store above is — the scoped fetch shim is a chrome capability
 * defined out here, and injection is conditioned on this binding (#22).
 * The dialog wiring maintains it; teardown clears it. */
let boundDestination: string | null = null;

/**
 * `polymorph:todomvc-spike/oauth-broker@0.0.1` — the PKCE ceremony runs
 * HERE, in chrome: a sandboxed panel can neither open a popup nor follow
 * a redirect, and must not see the ceremony at all. It names the client
 * it wants authorized; it receives only success or failure. The TOKENS
 * stay in chrome, deposited into chrome's own credential fields (#22) —
 * the powerbox shape: chrome shows what is authorized and holds the
 * resulting capability; the panel never touches it.
 */
async function authorize(clientId: string): Promise<void> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = b64url(verifierBytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = b64url(new Uint8Array(digest));
  const state = randomHex(8);
  const redirectUri = location.origin + location.pathname;

  const url = `https://www.dropbox.com/oauth2/authorize?client_id=${
    encodeURIComponent(clientId)
  }&response_type=code&code_challenge=${challenge}&code_challenge_method=S256` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&token_access_type=offline&state=${state}`;
  const popup = window.open(url, "pm-dropbox-auth", "width=680,height=760");
  if (!popup) witErr("could not open the authorization window (popup blocked)");

  const code = await new Promise<string>((resolve, reject) => {
    const done = (f: () => void) => {
      globalThis.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
      clearTimeout(deadline);
      f();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const d = e.data as { pmDropboxCode?: unknown; state?: unknown } | null;
      if (!d || typeof d.pmDropboxCode !== "string") return;
      // The state binding: a relay from another ceremony is ignored.
      if (d.state !== state) return;
      const c = d.pmDropboxCode;
      done(() => resolve(c));
    };
    globalThis.addEventListener("message", onMessage);
    const closedTimer = setInterval(() => {
      if (popup.closed) done(() => reject(new Error("authorization window closed")));
    }, 500);
    const deadline = setTimeout(
      () => done(() => reject(new Error("authorization timed out"))),
      AUTH_TIMEOUT_MS,
    );
  }).catch((e: unknown) => witErr(e instanceof Error ? e.message : String(e)));

  try {
    popup.close();
  } catch { /* already gone */ }

  // Token exchange: PKCE public client — the verifier, never a secret.
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) witErr(`token exchange: HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as { access_token?: string; refresh_token?: string };
  if (!json.access_token) witErr("token exchange: no access_token in the response");
  // Straight into CHROME's fields. Nothing is returned to the panel.
  depositCredential("bearer-token", json.access_token);
  depositCredential("refresh-token", json.refresh_token ?? "");
}

/** The one origin the Dropbox panel's grant — network AND credential —
 * points at. Chrome's own constant: the panel reports the same string,
 * but chrome never takes the panel's word for it (#22). */
const DROPBOX_DESTINATION = "https://api.dropboxapi.com";

/**
 * `polymorph:fetchspike/fetch@0.1.0`, scoped to one host. THIS SHIM IS
 * THE PER-DESTINATION NETWORK GRANT: the panel holds no ambient network
 * capability, only this closure, and the closure will not carry a
 * request anywhere but the Dropbox API. The refusal is a WIT err, not a
 * trap — a panel is entitled to observe (and render) a denied egress.
 */
const dropboxFetchImports = {
  "polymorph:fetchspike/fetch@0.1.0": {
    async request(
      method: string,
      url: string,
      headers: Array<[string, string]>,
      body: Uint8Array,
    ): Promise<{ status: number; body: Uint8Array }> {
      let host: string;
      let requestOrigin: string | null;
      try {
        const parsed = new URL(url);
        host = parsed.host;
        requestOrigin = normalizeOrigin(parsed.origin);
      } catch {
        witErr("fetch: host not granted to this panel");
      }
      if (host !== "api.dropboxapi.com") {
        witErr("fetch: host not granted to this panel");
      }
      // CREDENTIAL INJECTION AT THE GRANTED BOUNDARY (#22). The panel
      // holds no token and cannot set one: any panel-supplied
      // `authorization` header is DROPPED (it could only ever be a
      // guess, or an attempt to exfiltrate something by echoing it to
      // the wire), and chrome attaches the bearer credential it holds —
      // outside the sandbox, on the way out. With no token held, no
      // header is added and the provider's 401 is honest.
      //
      // The injection is also BOUND: the token goes out only toward the
      // destination chrome displayed in its credential fields. The host
      // allowlist above is the network grant; this is the credential
      // grant, and both must pass — the allowlist says where the request
      // may go, the binding says where the SECRET may go.
      const outbound = headers.filter(([k]) => k.toLowerCase() !== "authorization");
      const bearer = heldCredential("bearer-token");
      if (bearer && requestOrigin !== null && requestOrigin === boundDestination) {
        outbound.push(["authorization", `Bearer ${bearer}`]);
      }
      const empty = method === "GET" || method === "HEAD" || body.length === 0;
      const res = await fetch(url, {
        method,
        headers: outbound,
        // Copy out of the guest's view before it crosses back (and the
        // dom lib wants a plain ArrayBuffer, not a Uint8Array view).
        body: empty ? undefined : body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer,
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, body: buf };
    },
  },
};

// --- panes ---------------------------------------------------------------------

interface AppExports {
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  onRoute(route: string): Promise<void>;
  poll(): Promise<boolean>;
}

/** The `s3-panel` / `dropbox-panel` worlds: seed → run → on-event pump,
 * polling `outcome` after each event. some("") = cancelled,
 * some(json) = completed. */
interface PanelExports {
  seed(config: string): Promise<void>;
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  outcome(): Promise<string | undefined>;
  /** Chrome-driven: produce the config, or none if not yet valid. */
  commit(): Promise<string | undefined>;
  /** The panel's DECLARED credential needs, from the fixed WIT
   * vocabulary (`credentials.credential-kind`). Enum values cross the
   * boundary as their kebab-case WIT names ("access-key", …) — same
   * convention as `event-kind` ("dblclick"/"keydown") in the surface. */
  credentialNeeds(): Promise<string[]>;
  /** Where the panel's configuration currently points: a URL origin, or
   * "" for none. Chrome re-reads this after every pumped event, binds
   * its held credentials to it, and revalidates at commit time — the
   * panel REPORTS a destination, chrome DECIDES what it means. */
  destination(): Promise<string>;
}

/** Chrome's own normalization of a panel-reported destination: parse
 * with the platform's URL machinery and keep the ORIGIN only
 * (scheme + host + port; URL lowercases the scheme and host and gives
 * punycode for unicode hostnames — which is exactly the confusable
 * defence we want, since the comparison and the display then agree).
 * `null` for anything empty or unparseable, and for opaque origins
 * ("null") which cannot be compared meaningfully. */
function normalizeOrigin(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const origin = url.origin;
  // data:/blob:-style schemes serialize to "null" — not a destination.
  if (!origin || origin === "null") return null;
  return origin;
}

/** Chrome's own cleartext judgement (#22 rule 7): http to anything but
 * the loopback names means the credentials chrome holds would travel in
 * the clear. Chrome says this in chrome's words, from the NORMALIZED
 * origin — never from the panel's string. */
function isCleartextDestination(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return url.hostname !== "127.0.0.1" && url.hostname !== "localhost";
}

// --- chrome-owned credential fields (#22) --------------------------------------
//
// The phishing surface this closes: a panel that draws its own secret
// inputs is asking for credentials in ITS pixels while sitting inside
// chrome's dialog, borrowing chrome's authority. So a panel may only
// DECLARE a kind from a fixed vocabulary; chrome renders the field with
// CHROME'S OWN WORDS. Chrome never renders a panel-supplied label — that
// is the whole point: otherwise a panel declares "your Dropbox password"
// and chrome's pixels say it. Unknown kinds are refused outright, and
// the word "password" is never a label chrome writes.
interface CredentialSpec {
  label: string;
  type: "text" | "password";
  required: boolean;
  note?: string;
}

const CREDENTIAL_VOCABULARY: Record<string, CredentialSpec> = {
  "access-key": { label: "Access key ID", type: "text", required: true },
  "secret-key": { label: "Secret key", type: "password", required: true },
  "bearer-token": {
    label: "Access token",
    type: "password",
    required: true,
    note: "from provider sign-in, or paste a developer token",
  },
  "refresh-token": { label: "Refresh token (optional)", type: "password", required: false },
};

interface Pane {
  name: string;
  engine: Engine;
  id: Uint8Array;
  runner?: Runner;
  app?: AppExports;
  /** Polls dropped because the previous one was still in flight. */
  pollSkips?: number;
  status: (line: string, sticky?: boolean) => void;
}

// Beat results (pull outcomes, revocation guarantee notes) are the point
// of the demo, and the 4s stats refresh used to erase them within one
// tick. A beat status is STICKY: stats stand down until it expires.
const STICKY_MS = 12_000;
const stickyUntil = new Map<string, number>();

function statusLine(name: string): (line: string, sticky?: boolean) => void {
  const div = document.getElementById(`${name}-status`)!;
  return (line, sticky = false) => {
    if (!sticky && (stickyUntil.get(name) ?? 0) > performance.now()) return;
    if (sticky) stickyUntil.set(name, performance.now() + STICKY_MS);
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
  // A REAL sandboxed frame per app surface (#16), not the `direct`
  // backend: the app's nodes never enter chrome's document, so chrome's
  // personal strip colour is unreachable by construction rather than by
  // allowlist. See frame-backend.ts.
  const frameBackend = createFrameBackend(
    container as HTMLElement,
    (ev) => dispatch(ev),
  );
  const backend = await frameBackend.backend;
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
  // Remote changes surface as revision bumps; poll on a UI cadence —
  // but SKIP a tick whose predecessor is still running. `runner.call`
  // is an unbounded promise chain, so a poll that outlives its 400 ms
  // period (routine while the engine is busy syncing) would otherwise
  // append forever: the queue grows, latency grows with it, and the
  // page ends up wedged with every tick's closure still retained.
  let polling = false;
  pane.pollSkips = 0;
  setInterval(() => {
    if (polling) {
      pane.pollSkips!++;
      return;
    }
    polling = true;
    runner.call(() => app.poll())
      .catch(() => {})
      .finally(() => {
        polling = false;
      });
  }, 400);
}

// --- boot choreography -----------------------------------------------------------

function err(e: unknown): string {
  const p = (e as { payload?: unknown }).payload;
  return typeof p === "string" ? p : String(e);
}

/** Chrome's context slot: what secondary surface, if any, is on screen.
 * Called with null for "no secondary surface". The strip's own colour is
 * NOT touched here — it is the constant anchor; only the label changes. */
let setChromeContext: (
  surface: { name: string; hue: number; isNew: boolean } | null,
) => void = () => {};

function initChrome() {
  const { hue, fresh } = chromeHue();
  applyChromeHue(hue);
  const context = document.getElementById("chrome-context")!;
  const swatches = document.getElementById("chrome-swatches")!;
  const appearance = document.getElementById("chrome-appearance") as HTMLButtonElement;

  setChromeContext = (surface) => {
    context.replaceChildren();
    if (!surface) {
      const idle = document.createElement("span");
      idle.className = "said";
      idle.textContent = "3 app regions · alice · bob · tablet";
      context.append(idle);
      return;
    }
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = `oklch(62% .16 ${surface.hue})`;
    // Untrusted-string discipline: the component's name is QUOTED,
    // clamped by CSS, and never joined into chrome's own sentence.
    const name = document.createElement("q");
    name.className = "foreign";
    name.textContent = surface.name.slice(0, 40);
    const said = document.createElement("span");
    said.className = "said";
    said.textContent = "— provider configuration panel · drawn by the component, not by chrome";
    context.append(chip, name, said);
    if (surface.isNew) {
      // The TOFU moment is the one worth interrupting for: recognition
      // marks mean nothing the first time, and the first time is when
      // impersonation would land.
      const fresh = document.createElement("span");
      fresh.className = "fresh";
      fresh.textContent = "NEW — first time this component draws here";
      context.append(fresh);
    }
  };
  setChromeContext(null);

  // Constrained customisation: same lightness and chroma for every
  // choice, so contrast cannot be customised away.
  appearance.onclick = () => {
    if (swatches.classList.toggle("open")) {
      swatches.replaceChildren();
      for (const h of CHROME_HUES) {
        const b = document.createElement("button");
        b.style.background = `oklch(38% .07 ${h})`;
        b.title = `hue ${h}`;
        b.onclick = () => {
          applyChromeHue(h);
          try {
            localStorage.setItem(CHROME_KEY, String(h));
          } catch { /* not durable here */ }
          swatches.classList.remove("open");
        };
        swatches.append(b);
      }
    }
  };
  return { fresh };
}

async function boot() {
  const banner = document.getElementById("banner")!;
  const say = (s: string) => {
    banner.textContent = s;
    console.log(`[boot] ${s}`);
  };

  // An anchor that resets silently trains the user that it changes; a
  // reset is therefore announced.
  const { fresh } = initChrome();
  if (fresh) {
    const note = document.getElementById("chrome-rule")!;
    note.textContent = "new chrome colour set for this device — remember it";
    setTimeout(() => {
      note.textContent = "chrome never asks for your provider password";
    }, 15000);
  }

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
  let bgDepth = 0;
  const enqueue = (f: () => Promise<unknown>) => {
    bgDepth++;
    const next = bg.then(f).catch(() => {}).finally(() => {
      bgDepth--;
    });
    bg = next;
    return next;
  };
  /** Periodic work must never QUEUE: if the previous tick is still
   * running (consumer-API syncs take seconds, well past these periods),
   * appending another job grows the chain without bound — the queue
   * itself becomes the leak, and the page dies sluggish-then-locked.
   * Ticks are skipped instead, which is the correct semantics anyway:
   * a reconciliation pull is a refresh, not a transaction. */
  const periodic = (name: string, everyMs: number, f: () => Promise<unknown>) => {
    let running = false;
    let skipped = 0;
    setInterval(() => {
      if (running) {
        skipped++;
        return;
      }
      running = true;
      enqueue(f).finally(() => {
        running = false;
      });
    }, everyMs);
    return { name, skips: () => skipped };
  };

  // --- controls -------------------------------------------------------------

  // Subscriptions carry the realtime path; a background reconciliation
  // pull bounds any missed push (one in-browser push miss was observed;
  // recorded as a finding).
  const reconcile = periodic("reconcile", 2500, async () => {
    await pull(bob.engine, alice.id);
    await pull(alice.engine, bob.id);
  });

  // --- the bucket leg: user-configured, activates the tablet ---------------

  let bucketReady = false;
  let currentProvider: "s3" | "dropbox" = loadStorage()?.provider ?? "s3";
  // Dropbox link tier: Bob's standing pickup capability. Chrome carries
  // it here in lieu of the E2E channel the framework would use.
  let bobPickup: string | undefined;
  const syncBtn = document.getElementById("bucket-sync") as HTMLButtonElement;
  const autoBox = document.getElementById("bucket-auto") as HTMLInputElement;
  const pullBtn = document.getElementById("bob-pull") as HTMLButtonElement;
  syncBtn.disabled = true;
  autoBox.disabled = true;
  pullBtn.disabled = true;
  tablet.status("no storage configured — use Storage… to activate this pane");

  /** 4 random bytes of namespace: re-runs of the demo mint their own
   * folder (and their own links), so a stale run's revoked links never
   * collide with a fresh one's. */
  const sessionSuffix = () => `/run-${randomHex(4)}`;

  // Storage setup is ~20 sequential provider calls (consumer APIs run
  // ~0.5-1.5 s each), so a single "configuring…" line looks wedged for
  // half a minute. Each step announces itself instead, and a failure
  // says WHICH step died — the engine's transport errors now name the
  // request, so the two compose into an actionable message.
  // Guard against a SECOND setup while one is in flight. The 20 s
  // configure window makes "click Save again" the natural user response,
  // and a duplicate run re-mints container links and republishes pickup
  // objects underneath the first one — the failure mode is confusing
  // rather than harmless, so it is refused rather than queued.
  let setupInFlight = false;

  const setupBucket = (cfg: StorageConfig) => {
    // The flag is claimed SYNCHRONOUSLY, not inside the job: the
    // background chain serializes work, so a guard checked inside it
    // would always find the previous run finished and would happily
    // redo the whole thing. Verified by driving two calls in a row.
    if (setupInFlight) {
      tablet.status("storage setup already running — wait for it", true);
      return Promise.resolve();
    }
    setupInFlight = true;
    return enqueue(async () => {
      let step = "init";
      const at = (s: string) => {
        step = s;
        tablet.status(`configuring storage: ${s}…`, true);
      };
      try {
        at("provider config");
        currentProvider = cfg.provider;
        bobPickup = undefined;
        if (cfg.provider === "s3") {
          const owner: StoreConfig = {
            kind: "s3",
            value: {
              endpoint: cfg.endpoint,
              bucket: cfg.bucket,
              accessKey: cfg.access,
              secretKey: cfg.secret,
            },
          };
          // Bob is the recipient tier: no credentials, pulls only.
          const reader: StoreConfig = {
            kind: "s3",
            value: { endpoint: cfg.endpoint, bucket: cfg.bucket, accessKey: "", secretKey: "" },
          };
          await alice.engine.driver.initStore(owner);
          await tablet.engine.driver.initStore(owner);
          await bob.engine.driver.initStore(reader);
          at("bucket + policy");
          await alice.engine.driver.ensureBucket();
          at("grants");
          for (const m of [alice.id, bob.id, tablet.id]) {
            await alice.engine.driver.storeGrant(part, m); // S3: none
          }
        } else {
          const root = cfg.root + sessionSuffix();
          const val = {
            appKey: cfg.appKey,
            appSecret: cfg.appSecret,
            accessToken: cfg.accessToken,
            refreshToken: cfg.refreshToken,
            root,
          };
          // The tablet is Alice's OWN device: owner tier, same token.
          const owner: StoreConfig = { kind: "dropbox", value: val };
          // Bob is the link tier: no token, pulls ride his pickup link.
          const reader: StoreConfig = {
            kind: "dropbox",
            value: { ...val, accessToken: "", refreshToken: "" },
          };
          await alice.engine.driver.initStore(owner);
          await tablet.engine.driver.initStore(owner);
          await bob.engine.driver.initStore(reader);
          at("folders");
          await alice.engine.driver.ensureBucket();
          at("grant: alice");
          await alice.engine.driver.storeGrant(part, alice.id);
          at("grant: tablet");
          await alice.engine.driver.storeGrant(part, tablet.id);
          at("grant: bob (pickup link)");
          bobPickup = await alice.engine.driver.storeGrant(part, bob.id);
        }
        at("flush");
        await alice.engine.driver.bucketFlush(part);
        at("tablet cold pull");
        tablet.status(
          await tablet.engine.driver.bucketPull(part, alice.id, undefined),
          true,
        );
        bucketReady = true;
        syncBtn.disabled = false;
        autoBox.disabled = false;
        pullBtn.disabled = false;
      } catch (e) {
        // Name the step: a half-configured store is recoverable (every
        // provider call is idempotent), so "retry Save & connect" is
        // honest advice rather than a shrug.
        tablet.status(
          `storage setup failed at ${step}: ${err(e)} — check the endpoint/token and CORS, then Save & connect again`,
          true,
        );
      } finally {
        setupInFlight = false;
      }
    });
  };

  // The body, callable both from the button (queued once) and from the
  // periodic driver (which skips rather than queues).
  const bucketSyncOnce = async () => {
    if (!bucketReady) return;
    try {
      await alice.engine.driver.bucketFlush(part);
      await tablet.engine.driver.bucketFlush(part);
      tablet.status(await tablet.engine.driver.bucketPull(part, alice.id, undefined), true);
      alice.status(await alice.engine.driver.bucketPull(part, alice.id, undefined), true);
    } catch (e) {
      tablet.status(`bucket: ${err(e)}`, true);
    }
  };
  syncBtn.onclick = () => {
    enqueue(bucketSyncOnce);
  };
  const autoSync = periodic("auto-sync", 4000, async () => {
    if (autoBox.checked) await bucketSyncOnce();
  });

  // Bob pulling from the bucket is the revocation beat: S3 shows the
  // cooperative darkness (his K_p is gone), Dropbox the hard server-side
  // refusal (his link is revoked, and it was revoked retroactively).
  const bobPull = () =>
    enqueue(async () => {
      if (!bucketReady) return;
      try {
        const out = await bob.engine.driver.bucketPull(
          part,
          alice.id,
          currentProvider === "dropbox" ? bobPickup : undefined,
        );
        bob.status(`bucket: ${out}`, true);
      } catch (e) {
        bob.status(`bucket: ${err(e)}`, true);
      }
    });
  pullBtn.onclick = () => {
    bobPull();
  };

  // --- the storage dialog: chrome frame, sandboxed provider panel ----------
  //
  // #22's provisional ruling: a provider's config panel is an APP — its
  // own region, its own grants, launched FROM chrome, never rendered AS
  // chrome. Chrome owns the dialog, the tabs and the OAuth ceremony; the
  // panel owns the fields and hands back an opaque config blob.
  // Credentials never touch app code or chrome-rendered provider code.

  const dialog = document.getElementById("storage-dialog") as HTMLDialogElement;
  const region = document.getElementById("panel-region") as HTMLElement;
  const saveBtn = document.getElementById("storage-save") as HTMLButtonElement;

  // --- chrome's own credential fields ------------------------------------
  //
  // Created here, dynamically, and inserted ONCE between the granted
  // region and chrome's action row: these pixels are chrome's, drawn
  // from chrome's vocabulary (CREDENTIAL_VOCABULARY above), populated per
  // panel from the kinds the panel DECLARED. The panel never sees a
  // keystroke of them.
  const credBlock = document.createElement("div");
  credBlock.id = "chrome-credentials";
  credBlock.style.cssText =
    "margin:0 .9em .3em; padding:.6em .8em; background:#16213e; border:1px solid #2a2a44;" +
    "border-radius:3px; font-size:12px; color:#ddd; display:none;";
  const credLead = document.createElement("div");
  credLead.style.cssText = "font-size:11px; color:#8b93b0; margin-bottom:.5em; line-height:1.35;";
  credLead.textContent =
    "Held by chrome and handed to the storage engine — the panel below never sees these.";
  const credFields = document.createElement("div");
  // The BINDING LINE (#22): chrome's own sentence about where the values
  // it holds may be released. The origin inside it is panel-influenced
  // data, so it is quoted, monospaced and clamped — foreign-styled,
  // exactly like the surface name in the strip — and it is chrome's
  // NORMALIZED origin, never the panel's string as written.
  const credBinding = document.createElement("div");
  credBinding.id = "chrome-cred-binding";
  credBinding.style.cssText =
    "font-size:11px; color:#bbb; margin-bottom:.5em; line-height:1.4;" +
    "display:flex; align-items:baseline; gap:.35em; flex-wrap:wrap;";
  const credWarning = document.createElement("div");
  credWarning.style.cssText = "font-size:11px; color:#f5c16c; margin-bottom:.5em; line-height:1.35;";
  const credReason = document.createElement("div");
  credReason.style.cssText = "font-size:11px; color:#f5c16c; margin-top:.4em; line-height:1.35;";
  credBlock.append(credLead, credBinding, credWarning, credFields, credReason);
  {
    const actions = dialog.querySelector(".chrome-actions");
    if (actions) actions.before(credBlock);
    else region.after(credBlock);
  }

  /** Chrome's per-session credential state, keyed by WIT kind. The
   * inputs are the UI; this map is the value chrome hands onward (and
   * what the fetch shim injects from). */
  const credValues = new Map<string, string>();
  const credInputs = new Map<string, HTMLInputElement>();
  let credKinds: string[] = [];

  heldCredential = (kind) => credValues.get(kind) ?? "";
  depositCredential = (kind, value) => {
    credValues.set(kind, value);
    const input = credInputs.get(kind);
    if (input) input.value = value;
  };

  const clearCredentials = () => {
    credKinds = [];
    credValues.clear();
    credInputs.clear();
    credFields.replaceChildren();
    credReason.textContent = "";
    credBlock.style.display = "none";
    saveBtn.disabled = false;
    boundDestination = null;
    renderBinding();
  };

  /** The binding line, in chrome's own words. The origin it names is
   * chrome's normalization of what the panel reported — quoted and
   * foreign-styled because it is panel-INFLUENCED data, even after
   * normalization. No panel-supplied prose ever appears here. */
  function renderBinding() {
    credBinding.replaceChildren();
    credWarning.textContent = "";
    if (boundDestination === null) {
      // Rule 3: no destination, no fields. Chrome says why, and the
      // inputs cannot be typed into — there is nowhere to release to.
      const said = document.createElement("span");
      said.textContent =
        "no destination configured yet — credentials cannot be entered until the panel above names one";
      credBinding.append(said);
      for (const input of credInputs.values()) input.disabled = true;
      return;
    }
    for (const input of credInputs.values()) input.disabled = false;
    const lead = document.createElement("span");
    lead.textContent = "released only toward";
    const origin = document.createElement("q");
    origin.textContent = boundDestination.slice(0, 120);
    origin.style.cssText =
      "font-family: ui-monospace, monospace; max-width: 22em; overflow: hidden;" +
      "text-overflow: ellipsis; white-space: nowrap; color:#eee;";
    credBinding.append(lead, origin);
    if (isCleartextDestination(boundDestination)) {
      credWarning.textContent =
        "unencrypted destination — credentials will travel in the clear";
    }
  }

  /** Re-read the panel's destination and re-bind. A CHANGE is treated as
   * a new secret-handling decision: the values chrome holds were entered
   * for the old destination, so they are dropped rather than silently
   * re-aimed (#22 rule 2). Returns the new binding. */
  const rebind = (raw: string, { note = true }: { note?: boolean } = {}): string | null => {
    const next = normalizeOrigin(raw);
    if (next === boundDestination) {
      renderBinding();
      return next;
    }
    const had = boundDestination;
    boundDestination = next;
    // Clear held values AND the visible inputs: chrome's fields must not
    // keep showing a secret that is no longer bound to anything.
    for (const kind of credKinds) credValues.set(kind, "");
    for (const input of credInputs.values()) input.value = "";
    renderBinding();
    if (note && had !== null) {
      credReason.textContent = "destination changed — enter credentials for the new destination";
    }
    return next;
  };

  clearCredentials();

  /** Render the declared kinds — chrome's labels only. An unrecognised
   * kind is REFUSED rather than guessed at: chrome will not lend its
   * pixels to a request it has no words for, and Save is disabled so the
   * refusal cannot be clicked past. */
  const renderCredentials = (kinds: string[], prefill: Record<string, string>) => {
    credKinds = kinds;
    credValues.clear();
    credInputs.clear();
    credFields.replaceChildren();
    credReason.textContent = "";
    let refused = false;
    for (const kind of kinds) {
      const spec = CREDENTIAL_VOCABULARY[kind];
      if (!spec) {
        refused = true;
        continue;
      }
      const row = document.createElement("div");
      row.style.cssText = "display:flex; flex-direction:column; gap:.15em; margin-bottom:.5em;";
      const label = document.createElement("label");
      // CHROME'S OWN WORDS. Never a panel-supplied string.
      label.textContent = spec.label;
      label.style.cssText = "font-size:11px; color:#bbb;";
      const input = document.createElement("input");
      input.type = spec.type;
      input.autocomplete = "off";
      input.style.cssText =
        "width:100%; box-sizing:border-box; background:#0f1424; color:#eee;" +
        "border:1px solid #2a2a44; border-radius:2px; padding:.3em;";
      const seeded = prefill[kind] ?? "";
      input.value = seeded;
      credValues.set(kind, seeded);
      input.addEventListener("input", () => credValues.set(kind, input.value));
      credInputs.set(kind, input);
      row.append(label, input);
      if (spec.note) {
        const note = document.createElement("div");
        note.style.cssText = "font-size:10px; color:#8b93b0;";
        note.textContent = spec.note;
        row.append(note);
      }
      credFields.append(row);
    }
    if (refused) {
      credReason.textContent = "panel requested an unknown credential kind — refused";
    }
    saveBtn.disabled = refused;
    credBlock.style.display = kinds.length > 0 ? "" : "none";
    // The binding line sits above these fields and governs whether they
    // can be typed into at all (rule 3), so it is (re)drawn with them.
    renderBinding();
  };

  /** Requiredness is CHROME's rule, by kind — not the panel's. */
  const missingCredential = (): string | null => {
    for (const kind of credKinds) {
      const spec = CREDENTIAL_VOCABULARY[kind];
      if (!spec || !spec.required) continue;
      if ((credValues.get(kind) ?? "").trim() === "") return spec.label;
    }
    return null;
  };

  /** Chrome merges its held values into the panel's secret-free config.
   * The panel produced provider + public identifiers; the credentials
   * are added here, on chrome's side of the boundary. */
  const withCredentials = (cfg: StorageConfig): StorageConfig => {
    if (cfg.provider === "s3") {
      return {
        ...cfg,
        access: heldCredential("access-key"),
        secret: heldCredential("secret-key"),
      };
    }
    return {
      ...cfg,
      accessToken: heldCredential("bearer-token"),
      refreshToken: heldCredential("refresh-token"),
    };
  };

  /** What chrome hands the PANEL: the stored config with every secret
   * field stripped. A panel that never receives a credential cannot leak
   * one, and seeding is the one path that would otherwise hand it back. */
  const redactForPanel = (cfg: StorageConfig): Record<string, unknown> => {
    const copy = { ...cfg } as Record<string, unknown>;
    for (const secret of ["access", "secret", "accessToken", "refreshToken"]) {
      delete copy[secret];
    }
    return copy;
  };

  /** The destination chrome derives from a CONFIG — the committed blob's
   * own account of where it points, computed by chrome, not reported by
   * the panel. s3: the origin of its endpoint; dropbox: the fixed
   * provider origin (the same one its network grant is scoped to). */
  const configDestination = (cfg: StorageConfig): string | null =>
    cfg.provider === "s3" ? normalizeOrigin(cfg.endpoint) : DROPBOX_DESTINATION;

  /** Chrome's fields, prefilled from the stored config for this provider
   * — but ONLY when the stored config was for the SAME destination the
   * panel now points at (#22 rule 5). This is the password manager's
   * refusal to type a saved secret into a look-alike site: a panel that
   * seeds itself toward another origin gets empty fields and a note the
   * user can read, rather than chrome quietly handing over what it kept
   * from last time. */
  const credPrefill = (
    cfg: StorageConfig | null,
    provider: "s3" | "dropbox",
    bound: string | null,
  ): { prefill: Record<string, string>; mismatch: boolean } => {
    if (!cfg || cfg.provider !== provider) return { prefill: {}, mismatch: false };
    const storedDest = configDestination(cfg);
    if (bound === null || storedDest === null || storedDest !== bound) {
      return { prefill: {}, mismatch: true };
    }
    return {
      prefill: cfg.provider === "s3"
        ? { "access-key": cfg.access, "secret-key": cfg.secret }
        : { "bearer-token": cfg.accessToken, "refresh-token": cfg.refreshToken },
      mismatch: false,
    };
  };

  const tabs: Record<"s3" | "dropbox", HTMLButtonElement> = {
    s3: document.getElementById("prov-s3") as HTMLButtonElement,
    dropbox: document.getElementById("prov-dropbox") as HTMLButtonElement,
  };
  const panelArtifacts = new Map<string, EngineArtifacts>();
  let panelMounted: "s3" | "dropbox" | null = null;
  let activePanel:
    | { provider: "s3" | "dropbox"; panel: PanelExports; runner: Runner }
    | null = null;
  let panelDispatch: (ev: UiEvent) => void = () => {};
  /** The live panel surface's sandboxed frame, if any (see
   * frame-backend.ts). Teardown must destroy it explicitly: clearing the
   * region would orphan the port and the window listener. */
  let panelFrame: { destroy(): void } | null = null;

  /** Drop the panel: clear its granted subtree and cut the event path.
   * (Instance teardown proper is an OPEN deltic question — there is no
   * `drop`/`dispose` on an instantiated component yet; dropping our refs
   * and its DOM is the whole of the retirement we can express today.) */
  // Every mount takes a generation; teardown bumps it. Mounting is
  // async (artifact fetch + frame handshake), so without this a mount
  // that completes AFTER its dialog closed would append a live
  // component frame to a region nobody is looking at — an invisible
  // surface holding a granted rectangle.
  let panelGeneration = 0;
  const teardownPanel = () => {
    panelGeneration++;
    panelDispatch = () => {};
    // Close the port and drop the frame BEFORE clearing the region, so
    // the frame's window listener and MessagePort go with it rather than
    // being left holding a detached document.
    panelFrame?.destroy();
    panelFrame = null;
    region.innerHTML = "";
    panelMounted = null;
    activePanel = null;
    // No secondary surface on screen: the strip goes back to naming the
    // app regions. (The strip's COLOUR never changed — it is the anchor.)
    setChromeContext(null);
    region.style.removeProperty("--component-color");
    // The credential fields are PER-SESSION chrome state: when the
    // dialog's panel goes, so do the held values. (Durable persistence
    // of the full config in localStorage is unchanged.)
    clearCredentials();
  };

  const finishPanel = (outcome: string) => {
    // Merge BEFORE teardown: teardown clears chrome's per-session
    // credential state, so the values have to be taken out first.
    let cfg: StorageConfig | null = null;
    let parseError: unknown = null;
    if (outcome !== "") {
      try {
        cfg = withCredentials(JSON.parse(outcome) as StorageConfig);
      } catch (e) {
        parseError = e;
      }
    }
    teardownPanel();
    dialog.close();
    if (outcome === "") return; // some("") = cancelled
    try {
      if (parseError) throw parseError;
      if (!cfg) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
      if (bucketReady) {
        tablet.status("storage changed — reload the page to reconfigure");
      } else {
        setupBucket(cfg);
      }
    } catch (e) {
      tablet.status(`storage config unreadable: ${err(e)}`);
    }
  };

  const mountPanel = async (provider: "s3" | "dropbox") => {
    teardownPanel();
    const generation = ++panelGeneration;
    if (!dialog.open) return;
    for (const [k, btn] of Object.entries(tabs)) {
      btn.classList.toggle("active", k === provider);
    }
    const name = provider === "s3" ? "panel-s3" : "panel-dropbox";
    let art = panelArtifacts.get(name);
    if (!art) {
      art = await fetchArtifacts(name);
      panelArtifacts.set(name, art);
    }
    if (generation !== panelGeneration) return;
    // Bind the surface's identity into the strip BEFORE it can draw: the
    // hue is derived from the component's own bytes (assigned, not
    // chosen), and the same value tints the region's edge so the
    // untrusted rectangle and its chrome label visibly agree.
    // The mark is looked up by PROVENANCE (chrome fetched this artifact
    // itself, by this name, from its own origin) and assigned on first
    // sight — see surfaceMark.
    const { mark, isNew } = surfaceMark(name);
    const hue = mark.hue;
    // The component's colour is public (derived from its own bytes), but
    // scope it to the region anyway: chrome's document root stays clean.
    region.style.setProperty("--component-color", `oklch(62% .16 ${hue})`);
    setChromeContext({ name, hue, isNew });

    // Same sandboxed-frame treatment as the app panes: the panel handles
    // provider credentials, so the argument for keeping it out of
    // chrome's document is if anything stronger here.
    const frameBackend = createFrameBackend(region, (ev) => panelDispatch(ev), "dark");
    panelFrame = frameBackend;
    const backend = await frameBackend.backend;
    if (generation !== panelGeneration) {
      frameBackend.destroy();
      return;
    }
    const surface = createSurface(backend, () => "");
    // The capability profiles, side by side (#21): the S3 panel is PURE —
    // surface only, no egress. The Dropbox panel additionally holds the
    // broker and one host-scoped fetch.
    const imports = provider === "s3" ? { ...surface.imports } : {
      ...surface.imports,
      "polymorph:todomvc-spike/oauth-broker@0.0.1": { authorize },
      ...dropboxFetchImports,
    };
    const instance = await instantiate(
      artifactsFromEnvelope(art.envelope, art.bytes),
      imports,
    );
    if (generation !== panelGeneration) {
      frameBackend.destroy();
      return;
    }
    const panel = instance.exports as unknown as PanelExports;
    const runner = createRunner(surface);
    panelMounted = provider;
    // Chrome keeps the handles it needs to COMMIT; the panel only ever
    // gets events and answers questions.
    activePanel = { provider, panel, runner };
    panelDispatch = (ev) => {
      if (panelMounted !== provider) return;
      runner.call(() => panel.onEvent(ev))
        // The binding is LIVE (#22 rule 2): the panel's configuration can
        // move under chrome's feet with any keystroke, so chrome re-reads
        // the destination after every pumped event rather than trusting
        // the one it read at mount. A change drops the held values.
        .then(async () => {
          if (panelMounted !== provider || generation !== panelGeneration) return;
          const raw = await runner.call(() => panel.destination());
          if (panelMounted !== provider || generation !== panelGeneration) return;
          rebind(raw ?? "");
        })
        .catch((e) => console.warn(`[panel] event: ${err(e)}`));
    };
    const stored = loadStorage();
    // The panel is seeded with a REDACTED copy: its own public fields
    // only. Chrome's fields get the secrets (#22).
    const seedJson = stored && stored.provider === provider
      ? JSON.stringify(redactForPanel(stored))
      : "";
    await runner.call(() => panel.seed(seedJson));
    await runner.call(() => panel.run());
    if (generation !== panelGeneration) return;
    // The panel DECLARES its credential kinds; chrome renders them —
    // bound to the destination chrome reads back from the panel and
    // normalizes itself.
    const needs = await runner.call(() => panel.credentialNeeds());
    if (generation !== panelGeneration) return;
    const rawDest = await runner.call(() => panel.destination());
    if (generation !== panelGeneration) return;
    // note:false — this is the FIRST binding of the session, not a
    // change of one; there is nothing the user entered to invalidate.
    const bound = rebind(rawDest ?? "", { note: false });
    const { prefill, mismatch } = credPrefill(stored, provider, bound);
    renderCredentials(needs ?? [], prefill);
    if (mismatch && bound !== null) {
      credReason.textContent =
        "stored credentials are for a different destination — not filled";
    }
  };

  // <dialog> closes natively on ESC, which used to leave the component
  // running in a hidden region — so retirement must cover every close
  // path. The close EVENT should be that place, but at least one
  // embedding (the paseo webview: native close(), listener verified by
  // manual dispatch) flips `open` without ever delivering the queued
  // event, and also closes modals spuriously. So retirement triggers on
  // the STATE CHANGE itself — the `open` attribute — with the event kept
  // as belt-and-braces for engines where the attribute mutation and the
  // event race differently. teardownPanel is idempotent, so double
  // firing is free.
  dialog.addEventListener("close", () => teardownPanel());
  new MutationObserver(() => {
    if (!dialog.open && panelMounted !== null) teardownPanel();
  }).observe(dialog, { attributes: true, attributeFilter: ["open"] });

  const openStorage = () => {
    dialog.showModal();
    mountPanel(loadStorage()?.provider ?? "s3").catch((e) => {
      region.textContent = `panel failed to mount: ${err(e)}`;
    });
  };

  (document.getElementById("storage-open") as HTMLButtonElement).onclick = openStorage;
  for (const provider of ["s3", "dropbox"] as const) {
    tabs[provider].onclick = (ev) => {
      ev.preventDefault();
      if (panelMounted === provider) return;
      mountPanel(provider).catch((e) => {
        region.textContent = `panel failed to mount: ${err(e)}`;
      });
    };
  }
  // Chrome's Save: the commit belongs to the shell, so it is chrome that
  // asks the panel for a configuration and chrome that decides the
  // dialog is done. A panel refusing (none) leaves the dialog open with
  // its own explanation showing inside its region.
  (document.getElementById("storage-save") as HTMLButtonElement).onclick = (ev) => {
    ev.preventDefault();
    const active = activePanel;
    if (!active) return;
    active.runner.call(() => active.panel.commit())
      .then(async (out) => {
        if (out === undefined || out === "") return;
        // COMMIT-TIME REVALIDATION (#22 rule 4). Everything above was
        // read before the user clicked; between the render and the click
        // the panel could have re-pointed itself. So chrome re-reads the
        // destination NOW and holds it to three tests, in order — each
        // refusal in chrome's own words, dialog left open, credentials
        // NOT released.
        const raw = await active.runner.call(() => active.panel.destination());
        if (activePanel !== active) return;
        const now = normalizeOrigin(raw ?? "");
        if (now === null) {
          credReason.textContent =
            "no destination configured — credentials were not released";
          return;
        }
        if (now !== boundDestination) {
          // The displayed binding is what the user consented to; a panel
          // that moved since then gets the values dropped, not carried.
          rebind(raw ?? "");
          credReason.textContent =
            "the destination changed since these credentials were entered — nothing was released";
          return;
        }
        let cfgDest: string | null = null;
        try {
          cfgDest = configDestination(JSON.parse(out) as StorageConfig);
        } catch {
          cfgDest = null;
        }
        if (cfgDest === null || cfgDest !== boundDestination) {
          // The TOCTOU that motivates all of this: `destination()` says
          // one thing and the committed config points somewhere else.
          credReason.textContent =
            "the panel's configuration points somewhere else than the destination shown — nothing was released";
          return;
        }
        // The panel said its (secret-free) half is valid. Chrome now
        // judges ITS OWN fields, and says so in its own pixels — the
        // panel is not told which credential is missing.
        const missing = missingCredential();
        if (missing !== null) {
          credReason.textContent = `${missing} is required`;
          return;
        }
        credReason.textContent = "";
        finishPanel(out);
      })
      .catch((e) => console.warn(`[panel] commit: ${err(e)}`));
  };
  (document.getElementById("storage-cancel") as HTMLButtonElement).onclick = (ev) => {
    ev.preventDefault();
    teardownPanel();
    dialog.close();
  };

  const stored = loadStorage();
  if (stored) setupBucket(stored);

  (document.getElementById("revoke-bob") as HTMLButtonElement).onclick = () => {
    enqueue(async () => {
      try {
        await alice.engine.driver.khRevokeMember(part, bob.id);
        // The guarantee note is the point of the beat: cooperative-now
        // (S3) vs. hard + retroactive (Dropbox), in the provider's words.
        const note = await alice.engine.driver.storeRevoke(part, bob.id);
        await alice.engine.driver.bucketFlush(part);
        alice.status(`revoke: ${note}`, true);
        bob.status("REVOKED: new epochs are dark from here", true);
        (document.getElementById("bob-pane") as HTMLElement).classList.add("revoked");
      } catch (e) {
        alice.status(`revoke: ${err(e)}`);
      }
    });
  };

  // Live stats footer per pane (the tablet keeps its setup hint until
  // storage is configured).
  const statsTick = periodic("stats", 4000, async () => {
    for (const p of panes) {
      if (p === tablet && !bucketReady) continue;
      try {
        p.status(await p.engine.driver.stats());
      } catch { /* pane dead */ }
    }
  });

  // Debug/validation handles (the paseo browser driver uses these).
  (globalThis as unknown as Record<string, unknown>).__demo = {
    alice,
    bob,
    tablet,
    part,
    pull,
    bobPull: () => bobPull(),
    openStorage: () => openStorage(),
    // Exposed for driving: re-running setup is also how the in-flight
    // guard is exercised without racing a 20 s consumer-API window.
    setupBucket: (cfg: StorageConfig) => setupBucket(cfg),
    // Backpressure telemetry: queue depth plus per-timer skip counts.
    // If depth climbs monotonically, a periodic driver is queueing.
    health: () => ({
      bgDepth,
      skips: {
        reconcile: reconcile.skips(),
        autoSync: autoSync.skips(),
        stats: statsTick.skips(),
        poll: Object.fromEntries(panes.map((p) => [p.name, p.pollSkips ?? 0])),
      },
    }),
    authorize,
    // The isolation claim, made checkable instead of asserted: every
    // surface frame on the page must be UNREACHABLE from chrome's realm.
    // A sandboxed frame without `allow-same-origin` has an opaque origin,
    // so `contentDocument` is null (or throws) — if this ever reports
    // `sameOriginReachable: true`, the sandbox attribute has regressed
    // and chrome's pixels are once again in reach of component code.
    frameProbe: () => {
      const frames = Array.from(document.querySelectorAll("iframe"));
      let reachable = false;
      for (const f of frames) {
        try {
          if (f.contentDocument !== null) reachable = true;
        } catch { /* opaque origin: the expected outcome */ }
      }
      return {
        appFrames: frames.length,
        sameOriginReachable: reachable,
        sandbox: frames.map((f) => f.getAttribute("sandbox")),
      };
    },
    // The panel's granted fetch, exposed so the DENIAL side of the
    // per-destination grant is demonstrable and not merely asserted.
    panelFetch: dropboxFetchImports["polymorph:fetchspike/fetch@0.1.0"],
    // The live credential binding, for driving: what chrome believes the
    // held values may be released toward (null = nothing may).
    boundDestination: () => boundDestination,
  };
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
