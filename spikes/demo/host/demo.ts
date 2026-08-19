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
  // Scoped to the strip ELEMENT and to the credential drawer (the only
  // other surface chrome paints in the user's own colour), never to
  // :root. A custom property on the document root is ambient authority:
  // it inherits into every app region, so a component that ever gained a
  // `style` attribute (or a chrome class resolving var(--chrome-bg))
  // could paint chrome's exact colour without ever reading it. Keeping
  // the value out of scope makes the secrecy structural instead of a
  // property of the allowlist.
  for (const id of ["chrome-strip", "chrome-drawer"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.setProperty("--chrome-bg", `oklch(38% .07 ${hue})`);
    el.style.setProperty("--chrome-fg", "#f4f6fc");
  }
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
// THREE NAMES, STRICTLY SEPARATED (the petname triangle):
//   KEY       — the artifact name chrome fetched itself. Unforgeable
//               provenance; the only thing that may address a record.
//   NICKNAME  — what the component calls itself (`nickname()`).
//               Self-declared, so it is rendered as foreign-quoted text
//               and is never a key, never chrome's own voice.
//   PETNAME   — what the USER calls it, typed in chrome's pixels and
//               stored in the record. Chrome speaks this one in its own
//               voice, because the user wrote it.
// The demotion is the point: once a petname exists, the component's
// self-description drops to a footnote ("calls itself …") and the name
// with authority is the one the user chose.
const MARKS_KEY = "pm-demo-surface-marks";

interface SurfaceMark {
  hue: number;
  firstSeen: number;
  /** THE PETNAME: the user's own word for this component, typed in
   * chrome's own pixels and stored beside the mark. Optional — records
   * written before petnames existed stay valid and simply have none, so
   * there is no migration and an unnamed component keeps working exactly
   * as it did. It is NEVER a key (the key is provenance, above) and it
   * NEVER crosses the frame seam: no component may learn, influence, or
   * collide with the word the user chose for it. */
  petname?: string;
}

function loadMarks(): Record<string, SurfaceMark> {
  try {
    const table = JSON.parse(localStorage.getItem(MARKS_KEY) ?? "{}");
    return (table && typeof table === "object") ? table as Record<string, SurfaceMark> : {};
  } catch {
    return {};
  }
}

function saveMarks(table: Record<string, SurfaceMark>): void {
  try {
    localStorage.setItem(MARKS_KEY, JSON.stringify(table));
  } catch { /* nothing durable to write to */ }
}

function surfaceMark(provenance: string): { mark: SurfaceMark; isNew: boolean } {
  const table = loadMarks();
  const existing = table[provenance];
  if (existing) return { mark: existing, isNew: false };
  const used = new Set(Object.values(table).map((m) => m.hue));
  const free = CHROME_HUES.filter((h) => !used.has(h));
  const pool = free.length > 0 ? free : CHROME_HUES;
  const hue = pool[Math.floor(Math.random() * pool.length)];
  const mark = { hue, firstSeen: Date.now() };
  table[provenance] = mark;
  saveMarks(table);
  return { mark, isNew: true };
}

/** The hues no OTHER record is using, plus the one this record already
 * has. Local uniqueness is the property assignment buys (see above), so
 * the naming ceremony offers only colours that keep it. */
function freeHues(provenance: string): number[] {
  const table = loadMarks();
  const used = new Set(
    Object.entries(table).filter(([k]) => k !== provenance).map(([, m]) => m.hue),
  );
  const mine = table[provenance]?.hue;
  return CHROME_HUES.filter((h) => !used.has(h) || h === mine);
}

/** Is this word already the user's name for a DIFFERENT component?
 * Two records answering to one word would defeat the whole point of a
 * petname — the user would have no way to tell which one is speaking.
 * Compared trimmed and case-insensitively; returns the colliding record
 * (its petname as the user wrote it, and its unforgeable provenance key)
 * so chrome can say, in its own words, what the clash is. */
function petnameCollision(
  provenance: string,
  petname: string,
): { key: string; petname: string } | null {
  const want = petname.trim().toLowerCase();
  for (const [key, mark] of Object.entries(loadMarks())) {
    if (key === provenance) continue;
    const other = (mark.petname ?? "").trim();
    if (other !== "" && other.toLowerCase() === want) return { key, petname: other };
  }
  return null;
}

/** Commit a petname + mark hue for one record. */
function setPetname(provenance: string, petname: string, hue: number): void {
  const table = loadMarks();
  const mark = table[provenance] ?? { hue, firstSeen: Date.now() };
  mark.hue = hue;
  mark.petname = petname;
  table[provenance] = mark;
  saveMarks(table);
}

/** Delete the WHOLE record — mark, first-sight timestamp and petname
 * together. Forgetting must be honest: a component whose petname was
 * dropped but whose mark survived would still be greeted as familiar.
 * After this the next mount is genuinely NEW again, and says so. */
function forgetSurface(provenance: string): void {
  const table = loadMarks();
  delete table[provenance];
  saveMarks(table);
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
 * The PKCE ceremony, run HERE, in chrome: a sandboxed panel can neither
 * open a popup nor follow a redirect, and must not see the ceremony at
 * all. The TOKENS stay in chrome, deposited straight into chrome's own
 * credential fields (#22) — the powerbox shape: chrome shows what is
 * authorized and holds the resulting capability; no panel touches it.
 *
 * NO PANEL CAN TRIGGER THIS ANY MORE. It is invoked from the Connect
 * control chrome renders among the drawer's own fields, and `clientId`
 * comes from the drawer's own App key input — never across the
 * boundary. `oauth-broker` survives in the WIT as the recorded shape for
 * future surfaces (its `authorize` now takes no parameter, for exactly
 * this reason: the client identifier is chrome's), but the Dropbox
 * panel's import is GONE — an unused capability is a wrong grant (#21).
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
  /** What the panel CALLS ITSELF. Self-declared and unverified: read
   * once at mount, clamped, and rendered only as foreign-quoted text.
   * It is never a table key and never chrome's own voice. */
  nickname(): Promise<string>;
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
  // Provider-console identifiers. These are not secrets in the strict
  // sense — an app key ships inside every copy of a public client, and a
  // PKCE public client cannot use an app secret at all. They are here
  // anyway, because the rule the user is being taught has to hold
  // WITHOUT EXCEPTIONS: everything you paste out of a provider console
  // is typed under your colored bar. A panel that could draw one field
  // labelled "App secret" in its own pixels has already taught the user
  // that mid-page secret-ish fields are normal, which is the entire
  // phishing surface back again. Panels keep only provider-specific
  // NON-secret config (S3: endpoint, bucket; Dropbox: root folder).
  "app-key": {
    label: "App key",
    type: "text",
    required: true,
    note: "from the provider's app console",
  },
  "app-secret": { label: "App secret", type: "password", required: true },
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

/** What chrome knows about one component surface. `name` is the
 * unforgeable provenance key chrome fetched the artifact by; `nickname`
 * is what the component says about itself; `petname` is what the user
 * decided to call it. Only the last of the three is ever spoken in
 * chrome's own voice. */
interface SurfaceIdentity {
  name: string;
  nickname: string;
  hue: number;
  isNew: boolean;
  petname?: string;
}

/** Chrome's context slot: what secondary surface, if any, is on screen.
 * Called with null for "no secondary surface". The strip's own colour is
 * NOT touched here — it is the constant anchor; only the label changes.
 * `kind` says WHOSE pixels the secondary surface is: a component's
 * config panel, chrome's own credential sheet, or chrome's own naming
 * sheet. */
let setChromeContext: (
  surface: (SurfaceIdentity & { kind?: "panel" | "credentials" | "naming" }) | null,
) => void = () => {};

/** Chrome's naming ceremony, installed by `boot`. Module-level because
 * the strip's "name it" control is rendered by `initChrome`, which runs
 * before the drawer machinery exists. */
let requestNaming: (surface: SurfaceIdentity) => void = () => {};

/** The user's word for a component, in CHROME'S voice: not quoted, not
 * monospaced, because the user wrote it and chrome is entitled to say
 * it. Clamped anyway — the naming sheet caps input at 40, but a record
 * hand-edited in devtools should not be able to stretch the strip. */
function petnameSpan(petname: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "petname";
  el.textContent = petname.slice(0, 40);
  return el;
}

/** The component's own account of itself, always foreign: quoted,
 * monospaced, clamped, never joined into a chrome sentence. */
function nicknameQuote(nickname: string): HTMLElement {
  const q = document.createElement("q");
  q.className = "foreign";
  q.textContent = nickname.slice(0, 40);
  return q;
}

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
    const credentials = surface.kind === "credentials";
    const naming = surface.kind === "naming";
    // While a chrome sheet is open the strip NAMES it: the anchor and the
    // surface hanging off it say the same thing, so "which pixels am I
    // typing into" has a chrome-side answer.
    if (credentials || naming) {
      const lead = document.createElement("span");
      lead.className = "said";
      lead.textContent = credentials ? "storage credentials ·" : "naming ·";
      context.append(lead);
    }
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = `oklch(62% .16 ${surface.hue})`;
    context.append(chip);
    // THE DEMOTION. With a petname, the name chrome SAYS is the user's
    // own, in chrome's voice, and the component's self-description drops
    // to a footnote. Without one, all chrome has is what the component
    // calls itself — untrusted-string discipline: QUOTED, clamped by CSS,
    // never joined into chrome's own sentence.
    const petname = (surface.petname ?? "").trim();
    if (petname !== "") {
      const named = petnameSpan(petname);
      if (!credentials && !naming) {
        // The click target is chrome pixels in the strip — a place no
        // component can draw — so the ceremony cannot be baited from
        // inside an app rectangle.
        named.setAttribute("role", "button");
        named.setAttribute("tabindex", "0");
        named.classList.add("clickable");
        named.title = "rename or forget";
        named.onclick = () => requestNaming(surface);
        // A control that announces itself as a button to assistive tech
        // must BE one: Enter and Space activate it, exactly as they would
        // a real <button>. (Space is prevented from scrolling the page
        // out from under the ceremony it is about to open.)
        named.onkeydown = (ev: KeyboardEvent) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          if (ev.key === " ") ev.preventDefault();
          requestNaming(surface);
        };
      }
      const said = document.createElement("span");
      said.className = "said calls-itself";
      said.textContent = "calls itself";
      context.append(named, said, nicknameQuote(surface.nickname));
    } else {
      context.append(nicknameQuote(surface.nickname));
    }
    if (!credentials && !naming) {
      const said = document.createElement("span");
      said.className = "said";
      said.textContent = "— provider configuration panel · drawn by the component, not by chrome";
      context.append(said);
    }
    if (surface.isNew && !credentials && !naming) {
      // The TOFU moment is the one worth interrupting for: recognition
      // marks mean nothing the first time, and the first time is when
      // impersonation would land.
      const fresh = document.createElement("span");
      fresh.className = "fresh";
      fresh.textContent = "NEW — first time this component draws here";
      context.append(fresh);
    }
    if (petname === "" && !credentials && !naming) {
      // Chrome's own control, in chrome's own pixels: the offer to stop
      // relying on what the component says about itself.
      const nameIt = document.createElement("button");
      nameIt.id = "chrome-name-it";
      nameIt.type = "button";
      nameIt.textContent = "name it";
      nameIt.title = "give this component your own name";
      nameIt.onclick = () => requestNaming(surface);
      context.append(nameIt);
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
      note.textContent =
        "storage secrets are only entered in the sheet this bar reveals above itself";
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

  // --- chrome's own credential entry: the anchored drawer (#22) -----------
  //
  // The phishing surface this closes: a panel that draws its own secret
  // inputs is asking for credentials in ITS pixels while sitting inside
  // chrome's dialog, borrowing chrome's authority. So a panel may only
  // DECLARE a kind from a fixed vocabulary; chrome renders the field with
  // CHROME'S OWN WORDS (CREDENTIAL_VOCABULARY above). Chrome never
  // renders a panel-supplied label — that is the whole point: otherwise a
  // panel declares "your Dropbox password" and chrome's pixels say it.
  // Unknown kinds are refused outright, and the word "password" is never
  // a label chrome writes.
  //
  // What the drawer changes is WHERE those chrome-owned fields live. In
  // the dialog they sat mid-page between the sandboxed region and the
  // action row: chrome's pixels by construction, but not RECOGNISABLY so
  // — an app can draw that same rectangle, pixel for pixel, inside its
  // own region. They now live on a sheet that unfolds ABOVE the pinned
  // strip, painted in the user's own anchor colour, with the panel
  // already torn down and every remaining surface frozen and dimmed.
  //
  // ABOVE, not below, and the distinction is the whole defence. A sheet
  // BENEATH the strip is forgeable by adjacency: the strip floats over
  // scrollable content, so an app frame can be scrolled flush to the
  // strip's bottom edge and paint a counterfeit that appears attached to
  // the real bar. The band ABOVE the strip is unreachable at every scroll
  // offset — the strip is pinned to the viewport's top edge, so there is
  // no position an app can occupy there. And the sheet ARRIVES by pushing
  // the real strip down: an app can paint a sheet, but it cannot move
  // chrome's bar, so the reveal motion is itself unforgeable. Position is
  // the anchor, the motion is its proof, and the colour is secondary.
  const drawer = document.getElementById("chrome-drawer") as HTMLElement;
  const drawerInner = document.getElementById("chrome-drawer-inner") as HTMLElement;
  /** The bar the sheet opens above — measured for the sheet's height
   * budget, so the anchor can never be pushed off-screen. */
  const strip = document.getElementById("chrome-strip") as HTMLElement | null;
  const dim = document.getElementById("chrome-dim") as HTMLElement;
  /** The dialog's own refusal line: the commit-time destination checks
   * fail while the dialog is still open and no sheet exists yet. */
  const dialogReason = document.getElementById("storage-reason") as HTMLElement;
  const dialogNote = (text: string) => {
    dialogReason.textContent = text;
  };

  /** Chrome's per-session credential state, keyed by WIT kind. The
   * inputs are the UI; this map is the value chrome hands onward (and
   * what the fetch shim injects from). It outlives the panel: the OAuth
   * broker deposits into it DURING the panel session, and the drawer
   * opens after that panel is gone. */
  const credValues = new Map<string, string>();
  const credInputs = new Map<string, HTMLInputElement>();
  let credKinds: string[] = [];

  /** Element refs for the sheet currently on screen; null while the
   * drawer is closed, in which case every renderer below is a no-op. */
  let credFields: HTMLElement | null = null;
  let credBinding: HTMLElement | null = null;
  let credWarning: HTMLElement | null = null;
  let credReason: HTMLElement | null = null;
  const drawerNote = (text: string) => {
    if (credReason) credReason.textContent = text;
  };

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
    boundDestination = null;
  };

  /** The binding line, in chrome's own words. The origin it names is
   * chrome's normalization of what the panel reported — quoted and
   * foreign-styled because it is panel-INFLUENCED data, even after
   * normalization. No panel-supplied prose ever appears here. */
  function renderBinding() {
    if (!credBinding || !credWarning) return;
    credBinding.replaceChildren();
    credWarning.textContent = "";
    if (boundDestination === null) {
      // Rule 3: no destination, no fields. Chrome says why, and the
      // inputs cannot be typed into — there is nowhere to release to.
      // (The commit-time revalidation refuses to open the drawer at all
      // without a destination, so this is a defensive branch.)
      const said = document.createElement("span");
      said.textContent =
        "no destination configured — credentials cannot be entered until the panel names one";
      credBinding.append(said);
      for (const input of credInputs.values()) input.disabled = true;
      return;
    }
    const lead = document.createElement("span");
    lead.textContent = "released only toward";
    const origin = document.createElement("q");
    origin.className = "foreign";
    origin.textContent = boundDestination.slice(0, 120);
    credBinding.append(lead, origin);
    if (isCleartextDestination(boundDestination)) {
      credWarning.textContent = "unencrypted destination — credentials will travel in the clear";
    }
  }

  /** Re-read the panel's destination and re-bind. A CHANGE is treated as
   * a new secret-handling decision: the values chrome holds were entered
   * (or deposited by the OAuth broker) for the old destination, so they
   * are dropped rather than silently re-aimed (#22 rule 2). Returns the
   * new binding. */
  const rebind = (raw: string, { note = true }: { note?: boolean } = {}): string | null => {
    const next = normalizeOrigin(raw);
    if (next === boundDestination) {
      renderBinding();
      return next;
    }
    const had = boundDestination;
    boundDestination = next;
    // Clear held values AND any visible inputs: chrome must not keep
    // showing (or holding) a secret that is no longer bound to anything.
    credValues.clear();
    for (const input of credInputs.values()) input.value = "";
    renderBinding();
    if (note && had !== null) {
      dialogNote("destination changed — credentials will be requested for the new destination");
    }
    return next;
  };

  clearCredentials();

  /** Render the declared kinds INTO THE DRAWER — chrome's labels only.
   * An unrecognised kind is REFUSED rather than guessed at: chrome will
   * not lend its pixels to a request it has no words for, and Confirm
   * stays disabled so the refusal cannot be clicked past (Save is
   * likewise disabled back in the dialog, at mount time). Returns whether
   * anything was refused. */
  const renderCredentials = (kinds: string[], prefill: Record<string, string>): boolean => {
    credKinds = kinds;
    credInputs.clear();
    // Chrome ends up holding EXACTLY the kinds this sheet shows: anything
    // left over from the panel session (an OAuth deposit for a kind no
    // longer asked for) is dropped rather than quietly merged at Confirm.
    // Deposits that are still relevant arrive through `prefill`.
    credValues.clear();
    if (!credFields) return false;
    credFields.replaceChildren();
    let refused = false;
    for (const kind of kinds) {
      const spec = CREDENTIAL_VOCABULARY[kind];
      if (!spec) {
        refused = true;
        continue;
      }
      const row = document.createElement("div");
      row.className = "cred-field";
      const label = document.createElement("label");
      // CHROME'S OWN WORDS. Never a panel-supplied string.
      label.textContent = spec.label;
      const input = document.createElement("input");
      input.type = spec.type;
      input.autocomplete = "off";
      const seeded = prefill[kind] ?? "";
      input.value = seeded;
      credValues.set(kind, seeded);
      input.addEventListener("input", () => credValues.set(kind, input.value));
      credInputs.set(kind, input);
      row.append(label, input);
      if (spec.note) {
        const note = document.createElement("div");
        note.className = "hint";
        note.textContent = spec.note;
        row.append(note);
      }
      credFields.append(row);
    }
    if (refused) {
      drawerNote("panel requested an unknown credential kind — refused");
    }
    // The binding line governs whether these fields can be typed into at
    // all (rule 3), so it is (re)drawn with them.
    renderBinding();
    return refused;
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
      // The panel's blob carries `root` and nothing else; app key and app
      // secret are chrome's fields now, merged in here like every other
      // held value.
      appKey: heldCredential("app-key"),
      appSecret: heldCredential("app-secret"),
      accessToken: heldCredential("bearer-token"),
      refreshToken: heldCredential("refresh-token"),
    };
  };

  /** What chrome hands the PANEL: the stored config with every secret
   * field stripped. A panel that never receives a credential cannot leak
   * one, and seeding is the one path that would otherwise hand it back. */
  const redactForPanel = (cfg: StorageConfig): Record<string, unknown> => {
    const copy = { ...cfg } as Record<string, unknown>;
    // appKey/appSecret join the strip list: the panel does not render
    // them any more, so seeding them back would hand a component data it
    // has no field for and no business holding.
    for (
      const secret of ["access", "secret", "accessToken", "refreshToken", "appKey", "appSecret"]
    ) {
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
        : {
          "app-key": cfg.appKey,
          "app-secret": cfg.appSecret,
          "bearer-token": cfg.accessToken,
          "refresh-token": cfg.refreshToken,
        },
      mismatch: false,
    };
  };


  // --- the two-phase commit: dialog decides, drawer collects (#22) --------
  //
  // Phase 1 is the storage dialog: tabs, the sandboxed panel region and
  // Save/Cancel — and NO credential field anywhere in it. Phase 2 is this
  // drawer. Between them chrome tears the panel down, so by the time a
  // secret is on screen there is no component surface alive on the page
  // at all: not in the dialog (closed), not in a pane (paused), nowhere.
  // That invariant is the reason for the ordering below, and it must be
  // preserved by anything that touches this flow.

  /** The arming delay, ported from the todomvc chrome spike
   * (spikes/todomvc/host/chrome.ts:18): controls and inputs stay disabled
   * until it elapses, which defeats a baited mis-tap — an app training
   * rapid taps at a position where a chrome control is about to appear.
   * The TIMER is the enforcement; the slide is only its visible form, so
   * prefers-reduced-motion drops the animation and never the delay. */
  const ARM_MS = 700;

  /** What chrome holds between the two phases: the panel's secret-free
   * config, the destination chrome bound it to, and the surface mark of
   * the panel that produced it (for the provider line). Non-null exactly
   * while the drawer owns the interaction. */
  let drawerSession:
    | {
      cfg: StorageConfig;
      destination: string;
      surface: SurfaceIdentity;
    }
    | null = null;
  let armTimer = 0;
  /** Re-fitting listener for the open sheet, removed on close. */
  let drawerAnchor: (() => void) | null = null;

  /** THE NAMING SESSION — a second, LIGHTWEIGHT tenant of the same
   * drawer. It reuses the sheet's geometry (the reveal above the strip,
   * which is the unforgeable part) but NOT the credential session's
   * defences: no arming delay, no runner suspension, no page dim.
   *
   * Why that is not a downgrade. Arming defends SECRET ENTRY against a
   * baited mis-tap — an app training rapid taps where a chrome control is
   * about to appear — and suspension keeps component code from observing
   * or racing a secret. Naming is neither: nothing secret is typed, the
   * ceremony is initiated from strip pixels an app cannot draw or reach,
   * and the worst outcome of a mis-tap is an empty text field the user
   * closes. Paying the arming tax here would train users to click through
   * a delay that means something elsewhere, which is the real cost.
   *
   * THE CREDENTIAL SESSION ALWAYS WINS: naming refuses to open while a
   * credential sheet is up or arming, and an opening credential sheet
   * evicts a naming sheet. Both sessions share `drawer`/`drawerInner`, so
   * every deferred teardown below tests BOTH — a close timer from one
   * session must never blank the other's sheet (the late-teardown
   * ordering bug this file has hit before, in session-aware form). */
  let namingSession: { surface: SurfaceIdentity; hue: number } | null = null;
  let namingAnchor: (() => void) | null = null;

  /** Persist and connect: identical to the pre-drawer commit tail, just
   * moved behind the sheet's Confirm. */
  const persistAndConnect = (cfg: StorageConfig) => {
    try {
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

  const closeDrawer = () => {
    if (!drawerSession) return;
    drawerSession = null;
    clearTimeout(armTimer);
    if (drawerAnchor) globalThis.removeEventListener("resize", drawerAnchor);
    drawerAnchor = null;
    drawerInner.style.height = "0px";
    dim.hidden = true;
    // Input delivery resumes for every pane; the panel is already gone.
    for (const p of panes) p.runner?.resume();
    setChromeContext(null);
    // Held secrets die with the sheet: chrome keeps nothing after the
    // interaction it collected them for is over.
    clearCredentials();
    credFields = credBinding = credWarning = credReason = null;
    setTimeout(() => {
      // Session-aware, not drawer-scoped: a naming sheet may have claimed
      // the drawer in the meantime, and blanking it here would erase a
      // live sheet belonging to somebody else.
      if (!drawerSession && !namingSession) {
        drawerInner.replaceChildren();
        drawer.hidden = true;
      }
    }, ARM_MS);
  };

  /** Close the naming sheet. Deliberately NOT `closeDrawer`: that one
   * resumes runners, un-dims and clears held credentials, none of which
   * this session ever touched. */
  const closeNamingDrawer = ({ context = true }: { context?: boolean } = {}) => {
    if (!namingSession) return;
    namingSession = null;
    if (namingAnchor) globalThis.removeEventListener("resize", namingAnchor);
    namingAnchor = null;
    drawerInner.style.height = "0px";
    if (context) setChromeContext(null);
    setTimeout(() => {
      // Same session-aware test as the credential close: the credential
      // sheet may have evicted this one and be live in the drawer now.
      if (!namingSession && !drawerSession) {
        drawerInner.replaceChildren();
        drawer.hidden = true;
      }
    }, ARM_MS);
  };

  /** Build chrome's naming sheet. EVERY pixel here is chrome's. The only
   * component-influenced strings are the nickname and the provenance
   * key, both quoted, clamped and foreign-styled. */
  const buildNameSheet = (surface: SurfaceIdentity, hue: number) => {
    const root = document.createElement("div");
    root.className = "cred-sheet name-sheet armed";
    root.style.maxWidth = "72rem";
    root.style.marginLeft = "auto";
    root.style.marginRight = "auto";

    const h = document.createElement("h2");
    h.textContent = "Name this component";

    // Context, in the two voices that are not the user's: what the
    // component says about itself, and what chrome fetched it as.
    const says = document.createElement("div");
    says.className = "cred-line";
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = `oklch(62% .16 ${hue})`;
    const saysLead = document.createElement("span");
    saysLead.className = "said";
    saysLead.textContent = "calls itself";
    says.append(chip, saysLead, nicknameQuote(surface.nickname));

    const from = document.createElement("div");
    from.className = "cred-line";
    const fromLead = document.createElement("span");
    fromLead.className = "said";
    fromLead.textContent = "chrome fetched it as";
    const key = document.createElement("q");
    key.className = "foreign";
    key.textContent = surface.name.slice(0, 60);
    from.append(fromLead, key);

    const field = document.createElement("div");
    field.className = "cred-field";
    const label = document.createElement("label");
    label.textContent = "Your name for it";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.maxLength = 40;
    // NEVER PREFILLED FROM THE NICKNAME. A prefilled self-declared name
    // would let attacker-chosen words walk into chrome's voice by
    // accept-the-default — the user would "assign" a petname they never
    // wrote, and chrome would then speak it unquoted, which is exactly
    // the authority the whole three-name split exists to withhold. An
    // EXISTING petname is prefilled, because that one the user typed.
    input.value = surface.petname ?? "";
    input.placeholder = "a word you will recognise";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "chrome will use this name in its own voice; what the component calls itself stays quoted";
    field.append(label, input, hint);

    // Mark hue: the current one preselected, plus every hue no other
    // record is using (local uniqueness — see freeHues).
    const swatchLabel = document.createElement("div");
    swatchLabel.className = "cred-line said";
    swatchLabel.textContent = "recognition colour";
    const swatchRow = document.createElement("div");
    swatchRow.className = "name-swatches";
    let picked = hue;
    const buttons: HTMLButtonElement[] = [];
    for (const h of freeHues(surface.name)) {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = `oklch(62% .16 ${h})`;
      b.title = `hue ${h}`;
      b.classList.toggle("picked", h === hue);
      b.onclick = () => {
        picked = h;
        for (const other of buttons) other.classList.toggle("picked", other === b);
      };
      buttons.push(b);
      swatchRow.append(b);
    }

    const reason = document.createElement("div");
    reason.className = "cred-reason";

    const note = document.createElement("div");
    note.className = "cred-note";
    note.textContent =
      "this sheet is chrome's, opened from the bar below it — a component cannot draw here, and the name you choose is never given back to it";

    const row = document.createElement("div");
    row.className = "cred-row";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    row.append(saveBtn, cancelBtn);

    // Forgetting is offered only when there is something to forget.
    let forgetBtn: HTMLButtonElement | null = null;
    const forgetRow = document.createElement("div");
    forgetRow.className = "name-forget";
    if ((surface.petname ?? "").trim() !== "") {
      forgetBtn = document.createElement("button");
      forgetBtn.type = "button";
      forgetBtn.className = "forget";
      forgetBtn.textContent = "forget this component";
      const forgetNote = document.createElement("span");
      forgetNote.className = "hint";
      forgetNote.textContent = "drops the name AND the colour — next time it is NEW again";
      forgetRow.append(forgetBtn, forgetNote);
    }

    root.append(h, says, from, field, swatchLabel, swatchRow, note, reason, row);
    if (forgetBtn) root.append(forgetRow);
    return { root, input, saveBtn, cancelBtn, forgetBtn, reason, hue: () => picked };
  };

  const openNamingDrawer = (surface: SurfaceIdentity) => {
    // MUTUAL EXCLUSION, and the credential session wins outright: a sheet
    // that is collecting (or about to accept) secrets is never displaced
    // by a naming ceremony.
    if (drawerSession) return;
    if (namingSession) closeNamingDrawer({ context: false });
    const session = { surface, hue: surface.hue };
    namingSession = session;
    drawer.hidden = false;
    setChromeContext({ ...surface, kind: "naming" });

    const built = buildNameSheet(surface, surface.hue);
    drawerInner.replaceChildren(built.root);

    const finish = (status: string) => {
      closeNamingDrawer();
      // Chrome's own line in chrome's own bar — not a pane's status
      // line: this is a statement about the shell's trust table, not
      // about anybody's replica. Restored to the standing rule after,
      // the same way the fresh-anchor announcement is.
      if (status) {
        const rule = document.getElementById("chrome-rule");
        if (rule) {
          rule.textContent = status;
          setTimeout(() => {
            rule.textContent =
              "storage secrets are only entered in the sheet this bar reveals above itself";
          }, 8000);
        }
      }
    };

    built.saveBtn.onclick = () => {
      if (namingSession !== session) return;
      const petname = built.input.value.trim();
      if (petname === "") {
        // Refused rather than treated as "forget": clearing the field is
        // an ambiguous gesture, and Cancel is the unambiguous way out.
        built.reason.textContent = "type a name, or Cancel to leave it unnamed";
        return;
      }
      const clash = petnameCollision(surface.name, petname);
      if (clash) {
        // Chrome's own words, naming the colliding record by BOTH its
        // petname and its unforgeable provenance key — the user needs to
        // know which component already answers to this word.
        built.reason.textContent =
          `you already call another component "${clash.petname}" (fetched as ${clash.key}) — pick a different name`;
        return;
      }
      setPetname(surface.name, petname, built.hue());
      finish(`saved — chrome will call this component ${petname} from now on`);
    };
    built.cancelBtn.onclick = () => {
      if (namingSession !== session) return;
      finish("");
    };
    if (built.forgetBtn) {
      built.forgetBtn.onclick = () => {
        if (namingSession !== session) return;
        forgetSurface(surface.name);
        finish("forgotten — this component will be announced as NEW next time");
      };
    }

    // Same height budget as the credential sheet: the anchor must never
    // be pushed off-screen by a sheet that hangs off it.
    const fit = () => {
      const stripH = Math.ceil(strip?.getBoundingClientRect().height ?? 0);
      drawer.style.setProperty(
        "--chrome-sheet-max",
        `${Math.max(0, globalThis.innerHeight - stripH)}px`,
      );
    };
    const refit = () => {
      fit();
      if (namingSession !== session) return;
      drawerInner.style.height = "auto";
      drawerInner.style.height = `${drawerInner.offsetHeight}px`;
    };
    fit();
    namingAnchor = refit;
    globalThis.addEventListener("resize", refit);

    drawerInner.style.height = "auto";
    const target = drawerInner.offsetHeight;
    drawerInner.style.height = "0px";
    void drawerInner.offsetHeight;
    drawerInner.style.height = `${target}px`;
    // No arming delay (see namingSession): focus is given immediately,
    // because there is nothing here a mis-tap could spend.
    built.input.focus();
  };

  /** Build chrome's sheet. Every word here is chrome's; the only foreign
   * strings are the component's name and the destination origin, both
   * quoted, clamped and foreign-styled. */
  const buildSheet = (session: NonNullable<typeof drawerSession>, needs: string[]) => {
    const root = document.createElement("div");
    root.className = "cred-sheet";
    // The DRAWER spans the full window width (it hangs off the pinned
    // strip, which is full-width by construction — that is the anchor).
    // Its CONTENT is constrained to the same centered column the page
    // uses, so the sheet's fields line up with everything else instead
    // of stretching across a wide display.
    root.style.maxWidth = "72rem"; // rem: aligns with the page's --content-max column
    root.style.marginLeft = "auto";
    root.style.marginRight = "auto";

    const h = document.createElement("h2");
    h.textContent = "Storage credentials";

    // The requesting provider, by its surface mark: same chip colour the
    // strip showed while its panel was up. WHO is named the same way the
    // strip names it — the user's petname in chrome's voice when there is
    // one, with the component's self-description demoted to a foreign
    // footnote; otherwise only what the component calls itself, quoted.
    const who = document.createElement("div");
    who.className = "cred-line";
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = `oklch(62% .16 ${session.surface.hue})`;
    const lead = document.createElement("span");
    lead.textContent = "requested by";
    who.append(lead, chip);
    const petname = (session.surface.petname ?? "").trim();
    if (petname !== "") {
      const said = document.createElement("span");
      said.className = "said calls-itself";
      said.textContent = "calls itself";
      who.append(petnameSpan(petname), said, nicknameQuote(session.surface.nickname));
    } else {
      who.append(nicknameQuote(session.surface.nickname));
    }

    credBinding = document.createElement("div");
    credBinding.className = "cred-line";
    credWarning = document.createElement("div");
    credWarning.className = "cred-warning";
    credFields = document.createElement("div");
    credReason = document.createElement("div");
    credReason.className = "cred-reason";

    // CHROME'S OWN SIGN-IN CONTROL. It appears only when this session
    // actually needs both halves of the ceremony's inputs and outputs —
    // an app key to authorize against, and a bearer token to deposit.
    // It lives here rather than in the panel for the same reason the
    // fields do: it acts on the app key, and the app key is chrome's.
    // The panel cannot render it, cannot trigger it, and cannot observe
    // it; it only ever sees a later `fetch` that already works.
    let connectBtn: HTMLButtonElement | null = null;
    const connectRow = document.createElement("div");
    connectRow.className = "cred-connect";
    if (needs.includes("app-key") && needs.includes("bearer-token")) {
      connectBtn = document.createElement("button");
      connectBtn.type = "button";
      connectBtn.textContent = "Connect Dropbox (sign-in)";
      connectRow.append(connectBtn);
    }

    const note = document.createElement("div");
    note.className = "cred-note";
    note.textContent =
      "secrets are only ever typed here, in the space this bar just opened above itself — every app surface is frozen and dimmed while this sheet is open";

    const row = document.createElement("div");
    row.className = "cred-row";
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Confirm";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    row.append(confirmBtn, cancelBtn);

    root.append(h, who, credBinding, credWarning, credFields);
    if (connectBtn) root.append(connectRow);
    root.append(note, credReason, row);
    return { root, confirmBtn, cancelBtn, connectBtn };
  };

  const openCredentialDrawer = (
    session: NonNullable<typeof drawerSession>,
    needs: string[],
    prefill: Record<string, string>,
    mismatch: boolean,
  ) => {
    // The credential session takes the drawer from anything else holding
    // it: naming is an interruptible convenience, secret entry is not.
    // Closed WITHOUT touching the strip context, which this session is
    // about to claim for itself.
    if (namingSession) closeNamingDrawer({ context: false });
    drawerSession = session;
    // NO COMPONENT SURFACE IS LIVE WHILE SECRETS ARE ON SCREEN: the panel
    // was torn down by the caller before this ran, and every remaining
    // pane's runner is paused here — queued invocations are held, not
    // delivered, so app code can neither observe nor race the entry.
    for (const p of panes) p.runner?.pause();
    dim.hidden = false;
    drawer.hidden = false;
    // The strip names the sheet hanging off it, in the same colour it has
    // always had (the anchor never changes colour per surface).
    setChromeContext({ ...session.surface, kind: "credentials" });

    const { root, confirmBtn, cancelBtn, connectBtn } = buildSheet(session, needs);
    drawerInner.replaceChildren(root);
    const refused = renderCredentials(needs, prefill);
    if (mismatch) {
      drawerNote("stored credentials are for a different destination — not filled");
    }

    confirmBtn.onclick = () => {
      const s = drawerSession;
      if (!s) return;
      // Requiredness is chrome's rule, judged in chrome's pixels; the
      // panel is not told which credential was missing (it is gone).
      const missing = missingCredential();
      if (missing !== null) {
        drawerNote(`${missing} is required`);
        return;
      }
      // Chrome merges its held values into the panel's secret-free
      // config — the same withCredentials path as before the drawer.
      const full = withCredentials(s.cfg);
      closeDrawer();
      persistAndConnect(full);
    };
    if (connectBtn) {
      const btn = connectBtn;
      btn.onclick = async () => {
        // The app key comes from THIS SHEET's own field, never from a
        // panel: chrome authorizes against what the user typed under the
        // bar, so nothing a component said can steer the ceremony.
        const clientId = (credValues.get("app-key") ?? "").trim();
        if (clientId === "") {
          drawerNote("enter the App key first");
          return;
        }
        // Re-entrancy: the popup + token exchange is a long await, and a
        // second ceremony would race the deposit.
        btn.disabled = true;
        drawerNote("waiting for the provider's sign-in window…");
        try {
          await authorize(clientId);
          // The sheet may have been confirmed or cancelled while the
          // popup was up; its held values are gone, so a late deposit
          // must not be reported as this session's success.
          if (drawerSession !== session) return;
          drawerNote("signed in ✓ — the token fields above were filled by chrome");
        } catch (e) {
          if (drawerSession !== session) return;
          drawerNote(`sign-in failed: ${err(e)}`);
        } finally {
          if (drawerSession === session) btn.disabled = false;
        }
      };
    }
    cancelBtn.onclick = () => {
      // Nothing was persisted and nothing was released: the held config
      // and the held credentials both die here.
      closeDrawer();
      tablet.status("storage setup cancelled — nothing saved", true);
    };

    // Budget the sheet against the space it actually has. The sheet grows
    // ABOVE the strip inside one sticky assembly, so a sheet taller than
    // the viewport would push the strip off the bottom of the screen —
    // losing the anchor at the exact moment a secret is on screen. The
    // sheet is therefore capped at viewport-minus-strip and scrolls
    // internally past that (see .cred-sheet's --chrome-sheet-max).
    // Measured rather than hardcoded because the strip wraps to two rows
    // on a phone, and re-measured on resize/rotation.
    const fit = () => {
      // ceil: a fractional strip height (it wraps to two rows on a phone)
      // would otherwise leave the bar hanging a subpixel off the bottom.
      const stripH = Math.ceil(strip?.getBoundingClientRect().height ?? 0);
      const budget = Math.max(0, globalThis.innerHeight - stripH);
      drawer.style.setProperty("--chrome-sheet-max", `${budget}px`);
    };
    const refit = () => {
      fit();
      // The animated height is a pixel target, so it goes stale when the
      // budget changes under it; re-measure at auto and retarget.
      if (drawerSession !== session) return;
      drawerInner.style.height = "auto";
      const h = drawerInner.offsetHeight;
      drawerInner.style.height = `${h}px`;
    };
    fit();
    drawerAnchor = refit;
    globalThis.addEventListener("resize", refit);

    // Disabled BEFORE the first frame, inputs included: a secret must not
    // be typeable into a sheet the user has not yet had time to see.
    const controls: Array<HTMLButtonElement | HTMLInputElement> = [
      confirmBtn,
      cancelBtn,
      // Chrome's sign-in control is armed by the SAME delay as the rest:
      // it opens a provider window, which is exactly the sort of thing a
      // baited mis-tap should not be able to reach.
      ...(connectBtn ? [connectBtn] : []),
      ...credInputs.values(),
    ];
    for (const c of controls) c.disabled = true;

    // Animate 0 → the measured content height. One property drives the
    // whole assembly: the sheet's growth pushes the strip down and the
    // page content with it, on one curve (spikes/todomvc/host/chrome.ts:82-90
    // — scrollHeight misses the flex-end top-overflow, so measure at auto).
    drawerInner.style.height = "auto";
    const target = drawerInner.offsetHeight;
    drawerInner.style.height = "0px";
    void drawerInner.offsetHeight;
    drawerInner.style.height = `${target}px`;

    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      if (drawerSession !== session) return;
      for (const c of controls) c.disabled = false;
      // Rule 3 still governs the inputs after arming: with no bound
      // destination there is nowhere to release to, so nothing may be
      // typed. (Refused kinds keep Confirm out of reach for good.)
      if (boundDestination === null) {
        for (const input of credInputs.values()) input.disabled = true;
      }
      if (refused) confirmBtn.disabled = true;
      root.classList.add("armed");
    }, ARM_MS);
  };

  const tabs: Record<"s3" | "dropbox", HTMLButtonElement> = {
    s3: document.getElementById("prov-s3") as HTMLButtonElement,
    dropbox: document.getElementById("prov-dropbox") as HTMLButtonElement,
  };
  const panelArtifacts = new Map<string, EngineArtifacts>();
  let panelMounted: "s3" | "dropbox" | null = null;
  let activePanel:
    | {
      provider: "s3" | "dropbox";
      panel: PanelExports;
      runner: Runner;
      /** The surface mark chrome showed for this panel; the drawer
       * repeats it so "who asked" survives the panel's teardown. */
      surface: SurfaceIdentity;
    }
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
    // The strip goes back to naming the app regions — UNLESS a chrome
    // sheet has already claimed the strip context: the dialog's close
    // event/observer fires AFTER the handoff (the same late-teardown
    // ordering the retirement observer exists for), and resetting here
    // would blank the live sheet's line. Session-aware, not
    // surface-scoped: BOTH tenants of the drawer must be tested.
    if (drawerSession) {
      setChromeContext({ ...drawerSession.surface, kind: "credentials" });
    } else if (namingSession) {
      setChromeContext({ ...namingSession.surface, kind: "naming" });
    } else {
      setChromeContext(null);
    }
    region.style.removeProperty("--component-color");
    saveBtn.disabled = false;
    dialogNote("");
    // Held credentials are PER-SESSION chrome state: when the panel goes,
    // so do the values — UNLESS this teardown is the handoff into the
    // credential drawer, which is the one case where chrome must keep
    // holding them (the OAuth broker deposits during the panel session,
    // and the sheet that will show them opens a moment later). The drawer
    // clears them itself on Confirm or Cancel. Testing drawerSession
    // rather than a transient flag matters because at least one embedding
    // delivers the dialog's `close` event LATE — after the drawer is
    // already up — and that stray teardown must not wipe the sheet.
    if (drawerSession === null) clearCredentials();
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
    // Before instantiation chrome has nothing but provenance to show, so
    // that is what it shows — the nickname is a claim only the running
    // component can make, and it lands a moment later.
    let identity: SurfaceIdentity = {
      name,
      nickname: name,
      hue,
      isNew,
      petname: mark.petname,
    };
    setChromeContext(identity);

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
    // surface only, no egress. The Dropbox panel additionally holds
    // exactly ONE host-scoped fetch. It used to hold the OAuth broker
    // too; sign-in moved into chrome's drawer (where the app key is), so
    // the grant went with it rather than lingering unused.
    const imports = provider === "s3" ? { ...surface.imports } : {
      ...surface.imports,
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
    // WHAT THE COMPONENT CALLS ITSELF: read ONCE, here, and never again —
    // a name that could change under chrome's feet would be a name chrome
    // could not have shown the user before they acted on it. Clamped to
    // 40 at the read, exactly as `destination` is clamped at render, so
    // no downstream renderer has to remember. A hostile or broken panel
    // that traps, hangs the read, or answers with whitespace does NOT
    // take chrome down: chrome falls back to the provenance key it
    // fetched the artifact by, rendered foreign-quoted like any other
    // machine string.
    let nickname = name;
    try {
      const declared = await runner.call(() => panel.nickname());
      const clamped = (declared ?? "").trim().slice(0, 40);
      if (clamped !== "") nickname = clamped;
    } catch (e) {
      console.warn(`[panel] nickname: ${err(e)}`);
    }
    if (generation !== panelGeneration) return;
    identity = { ...identity, nickname };
    setChromeContext(identity);
    panelMounted = provider;
    // Chrome keeps the handles it needs to COMMIT; the panel only ever
    // gets events and answers questions.
    activePanel = { provider, panel, runner, surface: identity };
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
    // The panel DECLARES its credential kinds. Chrome does NOT render a
    // field here any more — entry happens later, in chrome's own drawer.
    // What chrome checks at mount is only whether it has WORDS for what
    // was asked: an unrecognised kind is refused up front and Save is
    // disabled, so the refusal cannot be clicked past into a sheet chrome
    // could not honestly label.
    const needs = await runner.call(() => panel.credentialNeeds());
    if (generation !== panelGeneration) return;
    const rawDest = await runner.call(() => panel.destination());
    if (generation !== panelGeneration) return;
    // note:false — this is the FIRST binding of the session, not a
    // change of one; there is nothing the user entered to invalidate.
    rebind(rawDest ?? "", { note: false });
    const unknown = (needs ?? []).some((kind) => !CREDENTIAL_VOCABULARY[kind]);
    saveBtn.disabled = unknown;
    dialogNote(unknown ? "panel requested an unknown credential kind — refused" : "");
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

  // Chrome's naming ceremony, reachable ONLY from the strip's own
  // pixels (see setChromeContext).
  requestNaming = (surface) => {
    // The credential session wins: while secrets are on screen (or
    // arming) the drawer is not available for anything else.
    if (drawerSession) return;
    // A modal <dialog> paints in the TOP LAYER — above the pinned chrome
    // zone, and therefore above the sheet the strip would reveal. So the
    // ceremony takes the page back first: the panel is retired and the
    // dialog closed (the same retirement path ESC takes) BEFORE chrome's
    // own sheet appears. Naming outliving the panel session is correct
    // anyway — the name is a statement about the component, not about
    // this visit to its configuration.
    if (dialog.open) {
      teardownPanel();
      dialog.close();
    }
    openNamingDrawer(surface);
  };

  const openStorage = () => {
    // The dialog would paint over the naming sheet (top layer); close it
    // rather than leave a live sheet stranded behind a modal.
    closeNamingDrawer();
    dialogNote("");
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
  //
  // PHASE 1 OF TWO. On success this does not connect: it takes the
  // secret-free config, retires the panel, closes the dialog, and hands
  // the interaction to chrome's credential drawer. Nothing is persisted
  // and no credential is released until the sheet's Confirm.
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
        // refusal in chrome's own words, dialog left open, NO drawer
        // opened and so no credential even askable for.
        const raw = await active.runner.call(() => active.panel.destination());
        if (activePanel !== active) return;
        const now = normalizeOrigin(raw ?? "");
        if (now === null) {
          dialogNote("no destination configured — credentials were not released");
          return;
        }
        if (now !== boundDestination) {
          // The binding chrome has been tracking is what the following
          // sheet would name; a panel that moved since then gets the
          // held values dropped, not carried.
          rebind(raw ?? "");
          dialogNote(
            "the destination changed since these credentials were entered — nothing was released",
          );
          return;
        }
        let cfg: StorageConfig | null = null;
        let cfgDest: string | null = null;
        try {
          cfg = JSON.parse(out) as StorageConfig;
          cfgDest = configDestination(cfg);
        } catch {
          cfg = null;
          cfgDest = null;
        }
        if (cfg === null || cfgDest === null || cfgDest !== boundDestination) {
          // The TOCTOU that motivates all of this: `destination()` says
          // one thing and the committed config points somewhere else.
          dialogNote(
            "the panel's configuration points somewhere else than the destination shown — nothing was released",
          );
          return;
        }
        // Chrome asks ONE more time what the panel needs: the drawer's
        // fields are drawn from this answer, and it must be the answer
        // the committed configuration was produced with.
        const needs = (await active.runner.call(() => active.panel.credentialNeeds())) ?? [];
        if (activePanel !== active) return;
        const stored = loadStorage();
        // Prefill is decided BEFORE teardown, while chrome still knows
        // which provider produced this config (#22 rule 5, unchanged).
        const { prefill, mismatch } = credPrefill(stored, active.provider, now);
        // Anything the OAuth broker deposited during the panel session is
        // chrome's own capture of a ceremony chrome ran; it survives into
        // the sheet, where the user can see it before releasing it.
        for (const [kind, value] of credValues) {
          if (value !== "") prefill[kind] = value;
        }
        const session = {
          cfg,
          destination: now,
          surface: active.surface,
        };
        // Claim the handoff BEFORE the teardown, so the panel's retirement
        // (and any late `close` event) leaves the held values alone.
        drawerSession = session;
        // ORDERING IS THE INVARIANT: the panel is retired and the dialog
        // is closed FIRST, so no component surface is alive on the page
        // when the credential sheet appears.
        teardownPanel();
        dialog.close();
        if (needs.length === 0) {
          // Nothing to ask for: no sheet, connect straight away.
          drawerSession = null;
          const full = withCredentials(cfg);
          clearCredentials();
          persistAndConnect(full);
          return;
        }
        openCredentialDrawer(session, needs, prefill, mismatch);
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
    // The credential sheet, for driving. `confirm`/`cancel` CLICK the
    // real buttons rather than calling the handlers, so a driver sees the
    // arming delay exactly as a user does: a click before ARM_MS lands on
    // a disabled button and does nothing.
    drawer: {
      open: () => drawerSession !== null,
      confirm: () =>
        (drawerInner.querySelector(".cred-row button:first-child") as
          | HTMLButtonElement
          | null)?.click(),
      cancel: () =>
        (drawerInner.querySelector(".cred-row button:last-child") as
          | HTMLButtonElement
          | null)?.click(),
    },
    // The naming ceremony, for driving. `nameIt` clicks the strip's own
    // control — chrome pixels, the only place the ceremony can start.
    naming: {
      open: () => namingSession !== null,
      nameIt: () =>
        (document.getElementById("chrome-name-it") as HTMLButtonElement | null)?.click(),
      type: (value: string) => {
        const input = drawerInner.querySelector(".name-sheet input") as HTMLInputElement | null;
        if (input) input.value = value;
      },
      save: () =>
        (drawerInner.querySelector(".name-sheet .cred-row button:first-child") as
          | HTMLButtonElement
          | null)?.click(),
      cancel: () =>
        (drawerInner.querySelector(".name-sheet .cred-row button:last-child") as
          | HTMLButtonElement
          | null)?.click(),
      forget: () =>
        (drawerInner.querySelector(".name-sheet .forget") as HTMLButtonElement | null)?.click(),
      reason: () =>
        (drawerInner.querySelector(".name-sheet .cred-reason") as HTMLElement | null)?.textContent ??
          "",
      marks: () => loadMarks(),
    },
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
