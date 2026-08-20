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
import { createRunner, type Runner } from "../../../visor/surface/runner.ts";
import { createFrameBackend } from "../../../visor/frame/frame-backend.ts";
import { createSurface } from "../../../visor/surface/surface.ts";
// The visor's system UI: the strip, the identity cluster, the context
// cluster and the drawer host. The demo is a CONSUMER of it — it supplies
// storage keys, the surface the strip falls back to, and the CONTENT of
// the three sheets it registers as drawer tenants.
import {
  identityIcon,
  IDENTITY_MAX,
  initVisor,
  nicknameQuote,
  petnameSpan,
  type SurfaceIdentity,
  VISOR_HUES,
  VISOR_ICONS,
  type VisorIdentity,
} from "../../../visor/ui/visor.ts";
import type { UiEvent } from "../../../visor/surface/events.ts";
import {
  type Driver,
  type Engine,
  type EngineArtifacts,
  type EngineNet,
  newEngine,
  type StoreConfig,
  type StoreFetch,
  type StoreSign,
  unhex,
  until,
} from "./engine.ts";
import {
  getSigningKey,
  makeSigner,
  putSigningKey,
  refusingSigner,
  type Signer,
} from "./keystore.ts";

// The live path rides n0's PUBLIC relay by default (interop proven in
// polymorph-iroh's `just interop-prod`); override with ?relay=… — e.g.
// a local `iroh-relay --dev` at http://127.0.0.1:3340.
const params = new URLSearchParams(location.search);
const RELAY = params.get("relay") ?? "https://use1-1.relay.n0.iroh.link";

// --- the OAuth redirect landing (visor-owned; #22 × #7) ------------------------
//
// The provider redirects the popup back to THIS page with ?code=&state=.
// That window's only job is to relay the code to the opener and go away:
// it must not boot a second demo (three more engines, a second wire).
// Navigation and redirect handling are visor capabilities — the panel
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
//
// WHAT IS NO LONGER IN HERE (#11): the S3 secret key. A stored config
// carries ADDRESSING plus public identifiers only; the signing
// credential lives in the keystore as a non-extractable handle, and the
// Dropbox tokens live in the visor's per-session credential state and the
// egress grant. A blob read out of localStorage can therefore no longer
// sign anything or be replayed as a bearer for S3.
type StorageConfig =
  | { provider: "s3"; endpoint: string; bucket: string; access: string }
  | {
    provider: "dropbox";
    appKey: string;
    appSecret: string;
    accessToken: string;
    refreshToken: string;
    root: string;
  };

const STORAGE_KEY = "pm-demo-storage";

// --- the visor's own storage keys ---------------------------------------------
//
// The visor ITSELF — the anchor colour and its palette, the hue
// load/migrate/announce semantics, the scoping discipline that keeps
// --visor-bg off :root, the identity record and its fixed glyph
// vocabulary, the strip, and the drawer host — lives in
// visor/ui/visor.ts. What stays here is the DEMO'S KEYS: two spikes
// sharing an origin must not share an anchor colour or an identity
// record, so the keys are the consumer's and the palette is the
// framework's.
const VISOR_KEY = "pm-demo-visor-hue";
// CONTRACT: rename-only migration (chrome -> visor, GitHub issue #22); the
// legacy key is read once by `initVisor` and then removed, never re-created.
const LEGACY_CHROME_KEY = "pm-demo-chrome-hue";
const IDENTITY_KEY = "pm-demo-identity";

// Surface marks: the recognition colour the visor shows for a component is// ASSIGNED at first sight and stored in a trust record — never derived.
//
// Two derivations died here, both to the same attack: making THE VISOR'S
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
// FETCHED BY THE VISOR from its own origin (visor-verified provenance in
// this demo); when signed releases and publisher identity land (#3,
// #10), it becomes the publisher's verifying key. Durability follows
// the visor-hue story: these live with device state (#11), and a lost
// table means reassignment — visible, so it must be announced, never
// silent.
// THREE NAMES, STRICTLY SEPARATED (the petname triangle):
//   KEY       — the artifact name the visor fetched itself. Unforgeable
//               provenance; the only thing that may address a record.
//   NICKNAME  — what the component calls itself (`nickname()`).
//               Self-declared, so it is rendered as foreign-quoted text
//               and is never a key, never the visor's own voice.
//   PETNAME   — what the USER calls it, typed in the visor's pixels and
//               stored in the record. The visor speaks this one in its own
//               voice, because the user wrote it.
// The demotion is the point: once a petname exists, the component's
// self-description drops to a footnote ("calls itself …") and the name
// with authority is the one the user chose.
const MARKS_KEY = "pm-demo-surface-marks";

interface SurfaceMark {
  hue: number;
  firstSeen: number;
  /** THE PETNAME: the user's own word for this component, typed in
   * the visor's own pixels and stored beside the mark. Optional — records
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
  const free = VISOR_HUES.filter((h) => !used.has(h));
  const pool = free.length > 0 ? free : VISOR_HUES;
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
  return VISOR_HUES.filter((h) => !used.has(h) || h === mine);
}

/** Is this word already the user's name for a DIFFERENT component?
 * Two records answering to one word would defeat the whole point of a
 * petname — the user would have no way to tell which one is speaking.
 * Compared trimmed and case-insensitively; returns the colliding record
 * (its petname as the user wrote it, and its unforgeable provenance key)
 * so the visor can say, in its own words, what the clash is. */
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

/** A secret found in a place secrets no longer live: an old stored blob,
 * or the `?secret=` seed URL. It is escrowed into the keystore and the
 * source is scrubbed — see `escrowPending`. Module-scoped and cleared on
 * use: it is the ONE transient the migration needs. */
let pendingEscrow: { origin: string; access: string; secret: string } | null = null;

/** Split a possibly-legacy S3 blob into today's addressing-only config
 * plus the secret that has to be escrowed and scrubbed. */
function splitLegacyS3(
  raw: { endpoint: string; bucket: string; access: string; secret?: string },
): StorageConfig {
  const cfg: StorageConfig = {
    provider: "s3",
    endpoint: raw.endpoint,
    bucket: raw.bucket,
    access: raw.access,
  };
  const origin = normalizeOrigin(raw.endpoint);
  if (raw.secret && origin !== null) {
    pendingEscrow = { origin, access: raw.access, secret: raw.secret };
  }
  return cfg;
}

function loadStorage(): StorageConfig | null {
  if (params.get("s3")) {
    // The ?secret= seed is treated exactly like a legacy stored secret:
    // escrowed on the way in, never re-persisted as a string.
    return splitLegacyS3({
      endpoint: params.get("s3")!,
      bucket: params.get("bucket") ?? "pm-demo",
      access: params.get("access") ?? "",
      secret: params.get("secret") ?? "",
    });
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const cfg = JSON.parse(raw) as StorageConfig & { secret?: string };
      // MIGRATION: a config written before #11 still carries the raw
      // secret. Split it out here; `escrowPending` imports it and writes
      // the blob back without the field.
      if (cfg.provider === "s3") return splitLegacyS3(cfg);
      return cfg;
    }
    const legacy = localStorage.getItem(LEGACY_S3_KEY);
    if (legacy) {
      const s3 = JSON.parse(legacy) as {
        endpoint: string;
        bucket: string;
        access: string;
        secret: string;
      };
      return splitLegacyS3(s3);
    }
    return null;
  } catch {
    return null;
  }
}

/** Finish the migration: import any secret found in cleartext storage as
 * a non-extractable handle, then rewrite the stored config WITHOUT it.
 * Idempotent — after one run there is nothing left to find. */
async function escrowPending(cfg: StorageConfig | null): Promise<void> {
  const pending = pendingEscrow;
  pendingEscrow = null;
  if (!pending || pending.secret === "") return;
  try {
    await putSigningKey(pending.origin, pending.access, pending.secret);
    if (cfg) localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    localStorage.removeItem(LEGACY_S3_KEY);
    console.log("[keystore] migrated a stored secret into a non-extractable signing key");
  } catch (e) {
    console.warn(`[keystore] migration failed: ${e}`);
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

/** The artifact name the visor fetches the app by — and therefore the KEY
 * of the app's row in the surface-mark table. Provenance, never a
 * self-declared name (see surfaceMark). */
const APP_ARTIFACT = "app";

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

// --- visor capabilities the panels do NOT have -------------------------------

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

/** The visor's credential store for the live dialog session. Installed by
 * the dialog wiring in `boot`; module-level so the broker and the scoped
 * fetch shim (both visor capabilities defined out here) can deposit and
 * read WITHOUT the values ever passing through a panel. Per-session: the
 * dialog's teardown clears them. */
let depositCredential: (kind: string, value: string) => void = () => {};
let heldCredential: (kind: string) => string = () => "";
/** The destination the visor's held credentials are BOUND to: a normalized
 * origin, or null while there is none. Module-level for the same reason
 * the store above is — the scoped fetch shim is a visor capability
 * defined out here, and injection is conditioned on this binding (#22).
 * The dialog wiring maintains it; teardown clears it. */
let boundDestination: string | null = null;

/**
 * The PKCE ceremony, run HERE, in the visor: a sandboxed panel can neither
 * open a popup nor follow a redirect, and must not see the ceremony at
 * all. The TOKENS stay in the visor, deposited straight into the visor's own
 * credential fields (#22) — the powerbox shape: the visor shows what is
 * authorized and holds the resulting capability; no panel touches it.
 *
 * NO PANEL CAN TRIGGER THIS ANY MORE. It is invoked from the Connect
 * control the visor renders among the drawer's own fields, and `clientId`
 * comes from the drawer's own App key input — never across the
 * boundary. `oauth-broker` survives in the WIT as the recorded shape for
 * future surfaces (its `authorize` now takes no parameter, for exactly
 * this reason: the client identifier is the visor's), but the Dropbox
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
  // Straight into THE VISOR's fields. Nothing is returned to the panel.
  depositCredential("bearer-token", json.access_token);
  depositCredential("refresh-token", json.refresh_token ?? "");
}

/** The one origin the Dropbox panel's grant — network AND credential —
 * points at. The visor's own constant: the panel reports the same string,
 * but the visor never takes the panel's word for it (#22). */
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
      // the wire), and the visor attaches the bearer credential it holds —
      // outside the sandbox, on the way out. With no token held, no
      // header is added and the provider's 401 is honest.
      //
      // The injection is also BOUND: the token goes out only toward the
      // destination the visor displayed in its credential fields. The host
      // allowlist above is the network grant; this is the credential
      // grant, and both must pass — the allowlist says where the request
      // may go, the binding says where the SECRET may go.
      const outbound = headers.filter(([k]) => k.toLowerCase() !== "authorization");
      const bearer = heldCredential("bearer-token");
      if (bearer && requestOrigin !== null && requestOrigin === boundDestination) {
        outbound.push(["authorization", `Bearer ${bearer}`]);
      }
      const empty = method === "GET" || method === "HEAD" || body.length === 0;
      try {
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
      } catch (e) {
        // Same rule as the engine's storage seams: a panel is entitled to
        // OBSERVE a failed request (it renders "check the endpoint"), and
        // an unbranded throw out of this import would trap it instead.
        witErr(`fetch: transport: ${err(e)}`);
      }
    },
  },
};

// --- the engine's storage egress: three named seams per instance (#7) --------
//
// The engine composite no longer imports a generic fetch. It imports
// `store-owner-fetch`, `store-public-fetch` and `store-signer`, and what
// each one is wired to IS the grant. Selection is by IMPORT NAME: a call
// site that wants to act as the user had to be written against the owner
// import when the guest was compiled, so attaching the wrong credential
// is inexpressible rather than checked. The near-miss the memo names is
// live here — on Dropbox the owner tier, the link tier and anonymous
// reads all talk to the SAME hosts, so destination-based injection would
// silently deanonymize the recipient path.
//
// REBIND, NOT RELINK. The wiring is fixed at instantiation; what changes
// when the user saves new storage settings is the CONTENTS of the mutable
// grant object each seam closes over. The handle names the relationship,
// not the token bytes — which is also why a refreshed Dropbox bearer
// needs no re-instantiation, and why an instance wired without authority
// can never acquire it by a later save.
interface EgressGrant {
  provider: "s3" | "dropbox" | null;
  /** Origins reachable AS THE USER. */
  origins: Set<string>;
  /** Origins reachable anonymously. */
  publicOrigins: Set<string>;
  /** Origins reachable as the APP (app auth, never user identity). */
  sharedOrigins: Set<string>;
  /** Dropbox owner tier only; never in a config, never in a component. */
  bearer?: string;
  refresh?: string;
  /** The app identifiers. Public by nature, and held by EVERY tier's
   * grant including the recipient's — app auth is the link tier's only
   * credential, and it says nothing about who is reading. */
  appKey?: string;
  appSecret?: string;
}

function emptyGrant(): EgressGrant {
  return {
    provider: null,
    origins: new Set(),
    publicOrigins: new Set(),
    sharedOrigins: new Set(),
  };
}

/** The visor's own reading of where a request is going. Structural
 * (scheme+host+port via the platform's URL parser), never a string
 * prefix test — prefix matching on URLs is how origin confinement is
 * usually gotten wrong. */
function requestOriginOf(url: string, tier: string): string {
  const o = normalizeOrigin(url);
  if (o === null) witErr(`${tier}: unparseable url`);
  return o;
}

/** One outbound request. The body is copied out of the guest's view
 * before it crosses back, and the dom lib wants a plain ArrayBuffer. */
async function sendRequest(
  /** Which seam is speaking — the brand on a transport refusal, so the
   * guest's error text names the import the call travelled through. */
  tier: string,
  method: string,
  url: string,
  headers: Array<[string, string]>,
  body: Uint8Array,
): Promise<{ status: number; body: Uint8Array }> {
  const empty = method === "GET" || method === "HEAD" || body.length === 0;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: empty ? undefined : body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer,
    });
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  } catch (e) {
    // A NETWORK CONDITION IS A RESULT, NOT A TRAP. `fetch` rejects with a
    // bare TypeError when the endpoint is down, DNS fails, CORS refuses
    // or the body read is cut short — and an UNBRANDED throw out of a
    // host import traps the component, killing an engine that was fully
    // prepared to cope: the guest retries transport failures three times
    // and labels them (`request_label`). Pre-retrofit the wasip3 http
    // shim returned the err side here, and losing that turned "MinIO is
    // not running" into a dead instance. So the throw is re-branded as
    // the err side of `result<response, string>`, which is the guest's
    // to handle.
    //
    // ONLY the transport call is wrapped. Origin refusals and the other
    // named errors above are already branded and must keep their own
    // words.
    witErr(`${tier}: transport: ${err(e)}`);
  }
}

const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

/** Percent-encode one `application/x-www-form-urlencoded` value — the
 * refresh body the guest used to build for itself. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `store-owner-fetch` for an instance holding `grant`. Acts as the user,
 * and the two providers differ in HOW:
 *
 * - S3: the request passes through untouched. The authority is the
 *   SIGNER — the guest built the x-amz headers and an Authorization
 *   value out of public parts plus a signature it had to ask for. There
 *   is nothing here to inject.
 * - Dropbox: a bearer token is disclosed to the destination by design
 *   (the SigV4-vs-bearer asymmetry recorded on #22), so this seam owns
 *   it: any component-supplied `authorization` is DROPPED — it could
 *   only be a guess or an attempt to echo something to the wire — and
 *   the visor attaches the token it holds, on the way out.
 */
function makeOwnerFetch(grant: EgressGrant): StoreFetch {
  return async (method, url, headers, body) => {
    if (grant.provider === null) {
      witErr("store-owner-fetch: no storage grant configured yet");
    }
    const target = requestOriginOf(url, "store-owner-fetch");
    if (!grant.origins.has(target)) {
      witErr(`store-owner-fetch: origin not granted: ${target}`);
    }
    if (grant.provider === "s3") {
      return await sendRequest("store-owner-fetch", method, url, headers, body);
    }
    const outbound = (token: string): Array<[string, string]> => {
      const h = headers.filter(([k]) => k.toLowerCase() !== "authorization");
      h.unshift(["authorization", `Bearer ${token}`]);
      return h;
    };
    const bearer = grant.bearer ?? "";
    if (bearer === "") {
      witErr("store-owner-fetch: no bearer token held for this instance");
    }
    const first = await sendRequest("store-owner-fetch", method, url, outbound(bearer), body);
    if (first.status !== 401 || !grant.refresh || !grant.appKey) return first;
    // TOKEN REFRESH IS THE SEAM'S BUSINESS NOW: the guest deleted its own
    // 401-refresh-retry along with the token it used to hold, so an
    // expired token must never become guest business again. Request shape
    // ported verbatim from what the guest deleted (see
    // spikes/tasks-engine/guest/src/lib.rs `dbx_refresh` in this branch's
    // diff): form-encoded, `client_id` in the body.
    //
    // CONTRACT: the dispatch described this as "Basic app auth". The
    // deleted guest code — and the visor's own PKCE authorization-code
    // exchange above — use the public-client shape instead, with no
    // Authorization header at all. The conservative reading is to
    // reproduce the code path that is known to have worked; a PKCE
    // public client cannot use an app secret anyway.
    const refreshBody =
      `grant_type=refresh_token&refresh_token=${formEncode(grant.refresh)}&client_id=${
        formEncode(grant.appKey)
      }`;
    // The refresh sub-request is transport too: a token endpoint that is
    // unreachable must not trap the component either. It also must not
    // REPLACE the answer the guest already has — an unreachable token
    // endpoint is not news about the request that 401'd — so a transport
    // failure here falls back to the honest 401, exactly like a non-200
    // refresh response does.
    let res: { status: number; body: Uint8Array };
    try {
      res = await sendRequest(
        "store-owner-fetch: refresh",
        "POST",
        DROPBOX_TOKEN_URL,
        [["content-type", "application/x-www-form-urlencoded"]],
        new TextEncoder().encode(refreshBody),
      );
    } catch {
      return first;
    }
    if (res.status !== 200) return first;
    let fresh = "";
    try {
      fresh = (JSON.parse(new TextDecoder().decode(res.body)) as { access_token?: string })
        .access_token ?? "";
    } catch { /* an unparseable refresh answer is just a failed refresh */ }
    if (fresh === "") return first;
    // Rebind: the grant's CONTENTS change, the wiring does not.
    grant.bearer = fresh;
    onBearerRefreshed(fresh);
    // Exactly ONE retry: a second 401 is an answer, not a race.
    return await sendRequest("store-owner-fetch", method, url, outbound(fresh), body);
  };
}

/**
 * `store-shared-fetch`: the APP-IDENTITY tier, and the third distinct
 * answer to "who is this request from". Dropbox will not serve a
 * shared-link read to an unauthenticated caller, but the credential it
 * wants identifies the APP — an app key and secret that ship inside every
 * copy of a public client, which is exactly why confidentiality can never
 * rest on them. Injecting them here is CALLER IDENTIFICATION, not
 * secrecy.
 *
 * What makes this worth its own import rather than a flag: the user's
 * bearer is wired to `store-owner-fetch`, so a recipient-path read cannot
 * identify the user BY CONSTRUCTION — there is no code path from this
 * seam to that credential. The memo's live near-miss (owner, link and
 * anonymous calls all going to the same host) is defused by the wiring
 * rather than by remembering to check.
 */
function makeSharedFetch(grant: EgressGrant): StoreFetch {
  return async (method, url, headers, body) => {
    if (grant.provider === null) {
      witErr("store-shared-fetch: no storage grant configured yet");
    }
    if (grant.provider !== "dropbox") {
      // S3 has no app tier at all: a request here would be a call site
      // asking for an identity this provider cannot mint.
      witErr("store-shared-fetch: no app tier on this provider");
    }
    const target = requestOriginOf(url, "store-shared-fetch");
    if (!grant.sharedOrigins.has(target)) {
      witErr(`store-shared-fetch: origin not granted: ${target}`);
    }
    // Any guest-supplied authorization is dropped first: what goes out is
    // the app identity the visor holds, or nothing at all.
    const outbound = headers.filter(([k]) => k.toLowerCase() !== "authorization");
    const appKey = grant.appKey ?? "";
    const appSecret = grant.appSecret ?? "";
    if (appKey !== "" && appSecret !== "") {
      // Standard HTTP Basic app auth. NOTE the deliberate asymmetry with
      // the refresh path in `makeOwnerFetch`: the PKCE token endpoint
      // takes `client_id` in the form body and no Authorization header,
      // whereas `get_shared_link_file` wants the Basic header. Two
      // endpoints, two shapes — neither is the other's bug.
      outbound.unshift(["authorization", `Basic ${btoa(`${appKey}:${appSecret}`)}`]);
    }
    // With nothing held, the request goes out unauthenticated and the
    // provider's refusal is honest — the same rule the owner shim's
    // missing-token path follows.
    return await sendRequest("store-shared-fetch", method, url, outbound, body);
  };
}

/**
 * `store-public-fetch`: the anonymous tier. It holds no identity, so
 * there is nothing it could attach; what it actively does is STRIP any
 * `authorization` the guest set. Anonymity is then a property of which
 * import the call site went through, not of a runtime check that could
 * be forgotten.
 */
function makePublicFetch(grant: EgressGrant): StoreFetch {
  return async (method, url, headers, body) => {
    if (grant.provider === null) {
      witErr("store-public-fetch: no storage grant configured yet");
    }
    const target = requestOriginOf(url, "store-public-fetch");
    if (!grant.publicOrigins.has(target)) {
      witErr(`store-public-fetch: origin not granted: ${target}`);
    }
    // Note the honest limit: `fetch` follows redirects itself, so the
    // allowlist governs the FIRST hop only. It is not a credential leak
    // (nothing is attached on this tier), which is exactly why the
    // Dropbox link tier's redirect chain is tolerable here and would not
    // be on the owner tier.
    return await sendRequest(
      "store-public-fetch",
      method,
      url,
      headers.filter(([k]) => k.toLowerCase() !== "authorization"),
      body,
    );
  };
}

/** The owner seam for an instance wired NO storage authority. It exists
 * and refuses — bob's read-only confinement is now visible in the
 * WIRING, where an auditor can see it, instead of being inferred from an
 * empty credential field in a config he could have filled in himself. */
const refusingOwnerFetch: StoreFetch = () =>
  Promise.reject(
    new ComponentException("store-owner-fetch: no storage credential wired for this instance"),
  );

/** Where a Dropbox instance may go, by tier. The owner tier talks to the
 * RPC host and the content host (uploads/downloads); the link tier's
 * pickup read goes to the content host, whose redirect hops land on
 * www.dropbox.com / dl.dropboxusercontent.com (spikes/dropbox/README.md:
 * "Network grant for this provider"). */
const DROPBOX_OWNER_ORIGINS = [
  "https://api.dropboxapi.com",
  "https://content.dropboxapi.com",
];
const DROPBOX_PUBLIC_ORIGINS = [
  "https://content.dropboxapi.com",
  "https://www.dropbox.com",
  "https://dl.dropboxusercontent.com",
];
/** The app tier reaches exactly one endpoint: the shared-link read. */
const DROPBOX_SHARED_ORIGINS = ["https://content.dropboxapi.com"];

/** Set when a grant's bearer is refreshed behind the seam, so the visor's
 * own copy (and its localStorage mirror) follow. Installed in `boot`. */
let onBearerRefreshed: (token: string) => void = () => {};

// --- panes ---------------------------------------------------------------------

interface AppExports {
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  onRoute(route: string): Promise<void>;
  poll(): Promise<boolean>;
  /** What the app CALLS ITSELF. Self-declared and unverified, exactly
   * like the panels' — read once, clamped, rendered only as
   * foreign-quoted text, never a table key. */
  nickname(): Promise<string>;
}

/** The `s3-panel` / `dropbox-panel` worlds: seed → run → on-event pump,
 * polling `outcome` after each event. some("") = cancelled,
 * some(json) = completed. */
interface PanelExports {
  seed(config: string): Promise<void>;
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  outcome(): Promise<string | undefined>;
  /** Visor-driven: produce the config, or none if not yet valid. */
  commit(): Promise<string | undefined>;
  /** The panel's DECLARED credential needs, from the fixed WIT
   * vocabulary (`credentials.credential-kind`). Enum values cross the
   * boundary as their kebab-case WIT names ("access-key", …) — same
   * convention as `event-kind` ("dblclick"/"keydown") in the surface. */
  credentialNeeds(): Promise<string[]>;
  /** Where the panel's configuration currently points: a URL origin, or
   * "" for none. The visor re-reads this after every pumped event, binds
   * its held credentials to it, and revalidates at commit time — the
   * panel REPORTS a destination, the visor DECIDES what it means. */
  destination(): Promise<string>;
  /** What the panel CALLS ITSELF. Self-declared and unverified: read
   * once at mount, clamped, and rendered only as foreign-quoted text.
   * It is never a table key and never the visor's own voice. */
  nickname(): Promise<string>;
}

/** The visor's own normalization of a panel-reported destination: parse
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

/** The visor's own cleartext judgement (#22 rule 7): http to anything but
 * the loopback names means the credentials the visor holds would travel in
 * the clear. The visor says this in the visor's words, from the NORMALIZED
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

// --- visor-owned credential fields (#22) --------------------------------------
//
// The phishing surface this closes: a panel that draws its own secret
// inputs is asking for credentials in ITS pixels while sitting inside
// the visor's dialog, borrowing the visor's authority. So a panel may only
// DECLARE a kind from a fixed vocabulary; the visor renders the field with
// THE VISOR'S OWN WORDS. The visor never renders a panel-supplied label — that
// is the whole point: otherwise a panel declares "your Dropbox password"
// and the visor's pixels say it. Unknown kinds are refused outright, and
// the word "password" is never a label the visor writes.
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
  net: EngineNet,
): Promise<Pane> {
  const engine = await newEngine(name, engineArtifacts, net);
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
  // backend: the app's nodes never enter the visor's document, so the visor's
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

/** THE APP'S OWN ROW IN THE TRUST TABLE. Registered once at boot, after
 * the app artifact is instantiated for the regions: ONE artifact drawn
 * into three regions is ONE record, so the strip names the component,
 * not the rectangles. Null until then (and if the nickname read fails,
 * the record still exists — only the self-declared name falls back). */
let appSurface: SurfaceIdentity | null = null;

async function boot() {
  const banner = document.getElementById("banner")!;
  const say = (s: string) => {
    banner.textContent = s;
    console.log(`[boot] ${s}`);
  };

  // THE VISOR. `contextOverride` is the demo's answer to "who owns the
  // strip right now, before any drawer tenant does": a LIVE COMPONENT
  // SURFACE is the only claimant that is not the visor's own, which makes
  // mislabelling it the one error with a victim. (`activePanel` is
  // declared further down this same function; the arrow is only ever
  // called after that point.)
  const visor = initVisor({
    hueKey: VISOR_KEY,
    legacyHueKey: LEGACY_CHROME_KEY,
    identityKey: IDENTITY_KEY,
    appSurface: () => appSurface,
    contextOverride: () => activePanel?.surface ?? null,
  });
  const setVisorContext = visor.setContext;
  const announce = visor.announce;

  // An anchor that resets silently trains the user that it changes; a
  // reset is therefore announced — on the visor's own line, which reverts
  // by re-render when the announcement expires.
  if (visor.fresh) {
    announce("new visor colour set for this device — remember it", 15000);
  }

  say("fetching artifacts…");
  const [engineArt, appArt] = await Promise.all([
    fetchArtifacts("engine"),
    fetchArtifacts(APP_ARTIFACT),
  ]);

  say("instantiating engines…");
  // THE GRANTS, one per authority rather than one per instance: alice and
  // the tablet are the SAME user's two devices, so they share the owner
  // grant (a refreshed Dropbox bearer is thereby refreshed for both, with
  // no re-instantiation). Bob is a different party and gets his own,
  // public-only grant.
  const ownerGrant = emptyGrant();
  const readerGrant = emptyGrant();

  // The signer behind alice's and the tablet's `store-signer` import. The
  // WIRING is fixed here at instantiation; `setupBucket` swaps what this
  // box holds when the user binds a new destination (rebind, not relink).
  // Null = nothing escrowed yet, and the seam says so rather than
  // pretending to be absent.
  let ownerSigner: Signer | null = null;
  const wiredSigner: StoreSign = (stringToSign, date, region, service) => {
    if (!ownerSigner) {
      return Promise.reject(
        new ComponentException("store-signer: no signing credential wired for this instance"),
      );
    }
    return ownerSigner(stringToSign, date, region, service);
  };
  const ownerNet: EngineNet = {
    ownerFetch: makeOwnerFetch(ownerGrant),
    publicFetch: makePublicFetch(ownerGrant),
    sharedFetch: makeSharedFetch(ownerGrant),
    signer: wiredSigner,
  };
  // BOB'S CONFINEMENT IS IN THE WIRING. His owner seam and his signer are
  // present and refuse; nothing about his config says "reader", and
  // nothing about it could say otherwise — he holds no import that could
  // act as anybody.
  // ...and the app tier is REAL for him: app auth is the recipient's only
  // credential, and it identifies the shipped client rather than the
  // person, so holding it costs him no anonymity.
  const readerNet: EngineNet = {
    ownerFetch: refusingOwnerFetch,
    publicFetch: makePublicFetch(readerGrant),
    sharedFetch: makeSharedFetch(readerGrant),
    signer: refusingSigner,
  };
  const alice = await newPane("alice", engineArt, ownerNet);
  const bob = await newPane("bob", engineArt, readerNet);
  const tablet = await newPane("tablet", engineArt, ownerNet);
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

  // --- THE APP JOINS THE TRUST TABLE ---------------------------------
  //
  // ONE ARTIFACT, ONE RECORD. The same `app` artifact is instantiated
  // into three regions (alice, bob, tablet); the regions are places
  // the visor drew it, not identities. So the visor registers exactly one
  // surface mark, keyed — like every other record — by the artifact name
  // THE VISOR FETCHED IT BY (unforgeable provenance in this demo; see
  // surfaceMark). The region names move to the App settings sheet as
  // metadata, where they describe the record rather than standing in for
  // it.
  //
  // Genuine first boot therefore shows NEW plus the visor's offer to name
  // it, on the strip's bottom line, for the app itself — the TOFU moment
  // the panels already had.
  const { mark: appMark, isNew: appIsNew } = surfaceMark(APP_ARTIFACT);
  // WHAT THE APP CALLS ITSELF: read ONCE, from ONE instance, exactly as
  // the panels' nickname is read — the app's exports are reachable from
  // the visor (the frame isolates the app's DOM, not its export surface;
  // see mountApp), so no new seam is needed. Same failure discipline: a
  // trap, an empty answer or whitespace falls back to the provenance
  // key, and the value is clamped at 40 on the way in so no downstream
  // renderer has to remember to.
  let appNickname = APP_ARTIFACT;
  try {
    const declared = alice.app && alice.runner
      ? await alice.runner.call(() => alice.app!.nickname())
      : "";
    const clamped = (declared ?? "").trim().slice(0, 40);
    if (clamped !== "") appNickname = clamped;
  } catch (e) {
    console.warn(`[app] nickname: ${err(e)}`);
  }
  appSurface = {
    name: APP_ARTIFACT,
    nickname: appNickname,
    hue: appMark.hue,
    isNew: appIsNew,
    petname: appMark.petname,
    firstSeen: appMark.firstSeen,
    // The visor's own words for the visor's own fact: where it drew this
    // artifact. Not component-influenced, so not foreign-quoted.
    meta: { label: "drawn in", value: panes.map((p) => p.name).join(", "), foreign: false },
  };
  // A repaint, not a context move: whatever is on the strip stays, and a
  // live announcement (the fresh-anchor one, at boot) keeps its line.
  visor.renderContext();

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
  // Dropbox link tier: Bob's standing pickup capability. The visor carries
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
          const origin = normalizeOrigin(cfg.endpoint);
          if (origin === null) {
            throw new Error(`storage endpoint is not a usable origin: ${cfg.endpoint}`);
          }
          // THE SIGNING AUTHORITY IS FETCHED FROM THE KEYSTORE, not from
          // the config: what the config carries is the address and the
          // public access-key identifier. No escrowed key for this
          // origin means this device cannot write, and saying so plainly
          // beats discovering it as a 403 twenty provider calls later.
          const held = await getSigningKey(origin);
          if (!held) {
            throw new Error(
              `no signing credential held for ${origin} — open Storage… and enter the secret key`,
            );
          }
          // REBIND: the grants' contents change; the instances' wiring
          // does not, and never will for the life of the page.
          ownerGrant.provider = "s3";
          ownerGrant.origins = new Set([origin]);
          ownerGrant.publicOrigins = new Set([origin]);
          // S3 has no app tier; an empty allowlist plus the provider
          // check in the shim means the seam refuses by name.
          ownerGrant.sharedOrigins = new Set();
          readerGrant.provider = "s3";
          readerGrant.origins = new Set();
          readerGrant.publicOrigins = new Set([origin]);
          readerGrant.sharedOrigins = new Set();
          ownerSigner = makeSigner(origin);
          const owner: StoreConfig = {
            kind: "s3",
            value: {
              endpoint: cfg.endpoint,
              bucket: cfg.bucket,
              accessKey: cfg.access,
            },
          };
          // Bob's config is the SAME SHAPE. His reader tier is not a
          // blank field any more — it is the fact that his owner seam
          // and his signer refuse.
          const reader: StoreConfig = {
            kind: "s3",
            value: { endpoint: cfg.endpoint, bucket: cfg.bucket, accessKey: "" },
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
          // Visor-held, grant-fed, config-free: the bearer and its
          // refresh (and the app identifiers the refresh needs) go into
          // the GRANT the owner seam closes over. The engine's config
          // gets addressing and nothing else.
          ownerGrant.provider = "dropbox";
          ownerGrant.origins = new Set(DROPBOX_OWNER_ORIGINS);
          ownerGrant.publicOrigins = new Set(DROPBOX_PUBLIC_ORIGINS);
          ownerGrant.sharedOrigins = new Set(DROPBOX_SHARED_ORIGINS);
          ownerGrant.bearer = cfg.accessToken;
          ownerGrant.refresh = cfg.refreshToken;
          ownerGrant.appKey = cfg.appKey;
          ownerGrant.appSecret = cfg.appSecret;
          readerGrant.provider = "dropbox";
          readerGrant.origins = new Set();
          readerGrant.publicOrigins = new Set(DROPBOX_PUBLIC_ORIGINS);
          readerGrant.sharedOrigins = new Set(DROPBOX_SHARED_ORIGINS);
          // The recipient's grant carries the APP identifiers and NOTHING
          // else: no bearer, no refresh. That asymmetry is the whole
          // recipient-anonymity claim, and it is visible right here.
          readerGrant.appKey = cfg.appKey;
          readerGrant.appSecret = cfg.appSecret;
          // No S3 signing on this provider; a stale signer from an
          // earlier S3 session must not survive the switch.
          ownerSigner = null;
          // The tablet is Alice's OWN device: owner tier, same grant.
          const owner: StoreConfig = { kind: "dropbox", value: { root } };
          // Bob is the link tier: same config, different wiring.
          const reader: StoreConfig = { kind: "dropbox", value: { root } };
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

  // A bearer refreshed BEHIND the seam is the visor's news, not the
  // component's: the grant already holds the new token (the seam wrote
  // it), and the visor's durable mirror follows so a reload does not start
  // from the expired one. The engine is never told; that is the point of
  // the handle naming the relationship rather than the bytes.
  onBearerRefreshed = (token: string) => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const cfg = JSON.parse(raw) as StorageConfig;
      if (cfg.provider !== "dropbox") return;
      cfg.accessToken = token;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch { /* nothing durable to write to; the grant still has it */ }
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

  // --- the storage dialog: visor frame, sandboxed provider panel ----------
  //
  // #22's provisional ruling: a provider's config panel is an APP — its
  // own region, its own grants, launched FROM the visor, never rendered AS
  // the visor. The visor owns the dialog, the tabs and the OAuth ceremony; the
  // panel owns the fields and hands back an opaque config blob.
  // Credentials never touch app code or visor-rendered provider code.

  const dialog = document.getElementById("storage-dialog") as HTMLDialogElement;
  const region = document.getElementById("panel-region") as HTMLElement;
  const saveBtn = document.getElementById("storage-save") as HTMLButtonElement;

  // --- the visor's own credential entry: the anchored drawer (#22) -----------
  //
  // The phishing surface this closes: a panel that draws its own secret
  // inputs is asking for credentials in ITS pixels while sitting inside
  // the visor's dialog, borrowing the visor's authority. So a panel may only
  // DECLARE a kind from a fixed vocabulary; the visor renders the field with
  // THE VISOR'S OWN WORDS (CREDENTIAL_VOCABULARY above). The visor never
  // renders a panel-supplied label — that is the whole point: otherwise a
  // panel declares "your Dropbox password" and the visor's pixels say it.
  // Unknown kinds are refused outright, and the word "password" is never
  // a label the visor writes.
  //
  // What the drawer changes is WHERE those visor-owned fields live. In
  // the dialog they sat mid-page between the sandboxed region and the
  // action row: the visor's pixels by construction, but not RECOGNISABLY so
  // — an app can draw that same rectangle, pixel for pixel, inside its
  // own region. They now live on a sheet that unfolds ABOVE the pinned
  // strip, painted in the user's own anchor colour, with the panel
  // already torn down and every remaining surface frozen and dimmed.
  //
  // The GEOMETRY of that reveal — above and never below, the push that
  // moves the real bar, the viewport-minus-strip height budget and the
  // arming delay — is the framework's, and its reasoning now lives with
  // it in visor/ui/visor.ts. What is left here is the CONTENT of the
  // sheet and the demo's own two-phase commit.
  /** The drawer's content box, for the driving handles at the bottom of
   * this file. The host owns it; the queries below only read it. */
  const drawerInner = document.getElementById("visor-drawer-inner") as HTMLElement;
  /** The dialog's own refusal line: the commit-time destination checks
   * fail while the dialog is still open and no sheet exists yet. */
  const dialogReason = document.getElementById("storage-reason") as HTMLElement;
  const dialogNote = (text: string) => {
    dialogReason.textContent = text;
  };

  /** The visor's per-session credential state, keyed by WIT kind. The
   * inputs are the UI; this map is the value the visor hands onward (and
   * what the fetch shim injects from). It outlives the panel: the OAuth
   * broker deposits into it DURING the panel session, and the drawer
   * opens after that panel is gone. */
  const credValues = new Map<string, string>();
  const credInputs = new Map<string, HTMLInputElement>();
  let credKinds: string[] = [];
  /** True when the visor ALREADY holds an escrowed signing key for the
   * destination this sheet is bound to. It changes two things and
   * nothing else: the secret-key field renders empty with a placeholder
   * saying so, and "empty" passes the visor's requiredness rule (empty =
   * keep the held key; non-empty = replace it). It is deliberately NOT a
   * relaxation of the destination binding — the lookup is keyed by the
   * SAME bound origin the triple revalidation just agreed on, so a panel
   * that re-points itself gets `false` here for free. */
  let heldSigningKey = false;

  /** Element refs for the sheet currently on screen; null while the
   * drawer is closed, in which case every renderer below is a no-op. */
  let credFields: HTMLElement | null = null;
  let credBinding: HTMLElement | null = null;
  let credWarning: HTMLElement | null = null;
  let credReason: HTMLElement | null = null;
  /** The open sheet's refusal line, in the visor's own words — a no-op
   * while no sheet has declared one (see `visor.drawer.setNote`). */
  const drawerNote = visor.drawer.note;

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
    heldSigningKey = false;
    boundDestination = null;
  };

  /** The binding line, in the visor's own words. The origin it names is
   * the visor's normalization of what the panel reported — quoted and
   * foreign-styled because it is panel-INFLUENCED data, even after
   * normalization. No panel-supplied prose ever appears here. */
  function renderBinding() {
    if (!credBinding || !credWarning) return;
    credBinding.replaceChildren();
    credWarning.textContent = "";
    if (boundDestination === null) {
      // Rule 3: no destination, no fields. The visor says why, and the
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
   * a new secret-handling decision: the values the visor holds were entered
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
    // Clear held values AND any visible inputs: the visor must not keep
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

  /** Render the declared kinds INTO THE DRAWER — the visor's labels only.
   * An unrecognised kind is REFUSED rather than guessed at: the visor will
   * not lend its pixels to a request it has no words for, and Confirm
   * stays disabled so the refusal cannot be clicked past (Save is
   * likewise disabled back in the dialog, at mount time). Returns whether
   * anything was refused. */
  const renderCredentials = (kinds: string[], prefill: Record<string, string>): boolean => {
    credKinds = kinds;
    credInputs.clear();
    // The visor ends up holding EXACTLY the kinds this sheet shows: anything
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
      // THE VISOR'S OWN WORDS. Never a panel-supplied string.
      label.textContent = spec.label;
      const input = document.createElement("input");
      input.type = spec.type;
      input.autocomplete = "off";
      if (kind === "secret-key" && heldSigningKey) {
        // The visor's own words for a credential it holds but cannot show:
        // the key is a non-extractable handle, so "leave blank to keep
        // it" is literally the only offer the visor can make.
        input.placeholder = "held as a non-extractable signing key — leave blank to keep it";
      }
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

  /** Requiredness is THE VISOR's rule, by kind — not the panel's. */
  const missingCredential = (): string | null => {
    for (const kind of credKinds) {
      const spec = CREDENTIAL_VOCABULARY[kind];
      if (!spec || !spec.required) continue;
      // A held key satisfies requiredness: the credential IS present,
      // the visor simply cannot render it. Requiredness stays the visor's rule
      // — this is the visor answering its own question with what it holds,
      // not the panel being allowed to skip a field.
      if (kind === "secret-key" && heldSigningKey) continue;
      if ((credValues.get(kind) ?? "").trim() === "") return spec.label;
    }
    return null;
  };

  /** The visor merges its held values into the panel's secret-free config.
   * The panel produced provider + public identifiers; the credentials
   * are added here, on the visor's side of the boundary. */
  const withCredentials = (cfg: StorageConfig): StorageConfig => {
    if (cfg.provider === "s3") {
      // The secret key is NOT merged in: it is escrowed into the keystore
      // at release time (`releaseCredentials`) and never becomes part of
      // a config object, in memory or in storage.
      return { ...cfg, access: heldCredential("access-key") };
    }
    return {
      ...cfg,
      // The panel's blob carries `root` and nothing else; app key and app
      // secret are the visor's fields now, merged in here like every other
      // held value.
      appKey: heldCredential("app-key"),
      appSecret: heldCredential("app-secret"),
      accessToken: heldCredential("bearer-token"),
      refreshToken: heldCredential("refresh-token"),
    };
  };

  /** What the visor hands the PANEL: the stored config with every secret
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

  /** The destination the visor derives from a CONFIG — the committed blob's
   * own account of where it points, computed by the visor, not reported by
   * the panel. s3: the origin of its endpoint; dropbox: the fixed
   * provider origin (the same one its network grant is scoped to). */
  const configDestination = (cfg: StorageConfig): string | null =>
    cfg.provider === "s3" ? normalizeOrigin(cfg.endpoint) : DROPBOX_DESTINATION;

  /** The visor's fields, prefilled from the stored config for this provider
   * — but ONLY when the stored config was for the SAME destination the
   * panel now points at (#22 rule 5). This is the password manager's
   * refusal to type a saved secret into a look-alike site: a panel that
   * seeds itself toward another origin gets empty fields and a note the
   * user can read, rather than the visor quietly handing over what it kept
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
        // No secret to prefill any more — there is no readable copy of
        // it anywhere. A HELD key shows as an empty field with the visor's
        // "already held" placeholder instead (see `heldKeyForSession`).
        ? { "access-key": cfg.access }
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
  // drawer. Between them the visor tears the panel down, so by the time a
  // secret is on screen there is no component surface alive on the page
  // at all: not in the dialog (closed), not in a pane (paused), nowhere.
  // That invariant is the reason for the ordering below, and it must be
  // preserved by anything that touches this flow.

  // --- THE DRAWER'S THREE TENANTS ------------------------------------------
  //
  // The host (visor/ui/visor.ts) owns the drawer, the reveal, the height
  // budget, the arming delay and every deferred teardown. What the demo
  // declares here is WHO may hold it, in what precedence, and what each
  // one has to undo. REGISTRATION ORDER IS PRECEDENCE ORDER — it is the
  // order `restoreContext` consults and the order evictions run in — so
  // the credential session is registered first.

  /** What the visor holds between the two phases: the panel's secret-free
   * config, the destination the visor bound it to, and the surface mark of
   * the panel that produced it (for the provider line). Non-null exactly
   * while the drawer owns the interaction. */
  interface CredentialSession {
    cfg: StorageConfig;
    destination: string;
    surface: SurfaceIdentity;
  }

  /** THE CREDENTIAL SESSION, and it ALWAYS WINS: `exclusive` means the
   * lightweight tenants refuse to open while this sheet is up or arming,
   * and that an opening credential sheet evicts either of them. It is
   * also the only `armed` tenant (a baited mis-tap must not be able to
   * spend a secret) and the only `dim`med one.
   *
   * NO COMPONENT SURFACE IS LIVE WHILE SECRETS ARE ON SCREEN: the panel
   * is torn down by the caller before the sheet opens, and every
   * remaining pane's runner is paused in `beforeShow` — queued
   * invocations are held, not delivered, so app code can neither observe
   * nor race the entry. */
  const credentialTenant = visor.drawer.tenant<CredentialSession>({
    name: "credentials",
    exclusive: true,
    armed: true,
    dim: true,
    // The strip names the sheet hanging off it, in the same colour it has
    // always had (the anchor never changes colour per surface).
    context: (s) => ({ ...s.surface, kind: "credentials" }),
    beforeShow: () => {
      for (const p of panes) p.runner?.pause();
    },
    // Input delivery resumes for every pane; the panel is already gone.
    afterCollapse: () => {
      for (const p of panes) p.runner?.resume();
    },
    // Held secrets die with the sheet: the visor keeps nothing after the
    // interaction it collected them for is over.
    afterRestore: () => {
      clearCredentials();
      credFields = credBinding = credWarning = credReason = null;
    },
  });

  /** THE NAMING SESSION — a LIGHTWEIGHT tenant of the same drawer. It
   * reuses the sheet's geometry (the reveal above the strip, which is the
   * unforgeable part) but NOT the credential session's defences: no
   * arming delay, no runner suspension, no page dim.
   *
   * Why that is not a downgrade. Arming defends SECRET ENTRY against a
   * baited mis-tap — an app training rapid taps where a visor control is
   * about to appear — and suspension keeps component code from observing
   * or racing a secret. Naming is neither: nothing secret is typed, the
   * ceremony is initiated from strip pixels an app cannot draw or reach,
   * and the worst outcome of a mis-tap is an empty text field the user
   * closes. Paying the arming tax here would train users to click through
   * a delay that means something elsewhere, which is the real cost.
   *
   * The session's `surface` is REASSIGNED after a Save (the sheet may
   * outlive the click, and a re-open is built from this object), so the
   * host holds the object rather than a copy. */
  const namingTenant = visor.drawer.tenant<{ surface: SurfaceIdentity; hue: number }>({
    name: "naming",
    context: (s) => ({ ...s.surface, kind: "naming" }),
  });

  /** THE SETTINGS SESSION — the THIRD tenant, lightweight on the same
   * grounds as naming: the reveal above the strip is kept (that is the
   * unforgeable part), the arming delay, runner suspension and page dim
   * are not. Nothing secret is typed here, it is opened from strip
   * pixels no app can draw or reach, and a mis-tap costs the user a form
   * they close.
   *
   * `hueAtOpen` is the colour the anchor had when the sheet opened: the
   * swatch row previews LIVE, so Cancel (and eviction) must be able to
   * put the anchor back exactly as it was. `commit` — passed by Save and
   * by nothing else — is what distinguishes them. An uncommitted preview
   * must not survive the sheet: the credential sheet that evicts this one
   * is painted in the anchor colour, and it must be painted in the REAL
   * one. */
  const settingsTenant = visor.drawer.tenant<{ hueAtOpen: number }>({
    name: "settings",
    context: () => ({ kind: "settings" }),
    beforeCollapse: (s, opts) => {
      if (!opts.commit) visor.applyHue(s.hueAtOpen);
    },
  });

  /** PUT THE STRIP BACK IN THE HANDS OF WHOEVER ACTUALLY OWNS IT NOW —
   * the host's recomputation, in the precedence order above, with the
   * live panel surface ahead of all three (see the `contextOverride`
   * passed to `initVisor`). No caller states what the context should
   * become; each one says only "I am done". */
  const restoreVisorContext = visor.drawer.restoreContext;

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

  // The three closes are the tenants' own, thin: everything they used to
  // do by hand — dropping the session, dropping the resize listener,
  // collapsing the sheet, un-dimming, restoring the strip to its rightful
  // owner and blanking the drawer only if nobody else claimed it
  // meanwhile — is the host's now, driven by the specs above.
  const closeDrawer = () => credentialTenant.close();
  const closeNamingDrawer = (opts: { context?: boolean } = {}) => namingTenant.close(opts);
  const closeSettingsDrawer = (opts: { context?: boolean; commit?: boolean } = {}) =>
    settingsTenant.close(opts);

  /** Build the visor's App settings sheet — the naming ceremony GROWN into
   * the one place the visor says everything it knows about a component.
   * EVERY pixel here is the visor's. The only component-influenced strings
   * are the nickname, the provenance key and (for a panel) its declared
   * destination — all quoted, clamped and foreign-styled.
   *
   * It is the SAME tenant and the same session variable as the old
   * naming sheet: evolved, not added to. A fourth drawer tenant would
   * have meant a fourth entry in every occupancy test (see
   * the host's occupancy test), for a sheet that is about exactly what naming was
   * about — this component, and what the user wants to call it. */
  const buildNameSheet = (surface: SurfaceIdentity, hue: number) => {
    const root = document.createElement("div");
    root.className = "cred-sheet name-sheet armed";
    root.style.maxWidth = "72rem";
    root.style.marginLeft = "auto";
    root.style.marginRight = "auto";

    const h = document.createElement("h2");
    h.textContent = "App settings";

    // THE IDENTITY BLOCK — the two voices that are not the user's: what
    // the component says about itself, and what the visor fetched it as.
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
    fromLead.textContent = "the visor fetched it as";
    const key = document.createElement("q");
    key.className = "foreign";
    key.textContent = surface.name.slice(0, 60);
    from.append(fromLead, key);

    // FIRST SIGHT, from the trust record itself: the date the mark was
    // assigned. This is the visor's own memory of the component, and the
    // only thing on the sheet that answers "have I really seen this
    // before?" with something other than a colour.
    const seen = document.createElement("div");
    seen.className = "cred-line";
    if (surface.firstSeen !== undefined) {
      const seenLead = document.createElement("span");
      seenLead.className = "said";
      seenLead.textContent = "first seen";
      const when = document.createElement("span");
      when.textContent = new Date(surface.firstSeen).toLocaleDateString();
      seen.append(seenLead, when);
    }

    // THE METADATA BLOCK — visor-known facts about this surface, when
    // there are any: a panel's declared destination, or the regions
    // the visor drew the app into. A component-influenced value is
    // foreign-quoted like every other thing a component said.
    const meta = document.createElement("div");
    meta.className = "cred-line";
    if (surface.meta) {
      const metaLead = document.createElement("span");
      metaLead.className = "said";
      // THE VISOR'S word, always — `label` is never component-supplied.
      metaLead.textContent = surface.meta.label;
      if (surface.meta.foreign) {
        const q = document.createElement("q");
        q.className = "foreign";
        q.textContent = surface.meta.value.slice(0, 120);
        meta.append(metaLead, q);
      } else {
        const value = document.createElement("span");
        value.textContent = surface.meta.value.slice(0, 120);
        meta.append(metaLead, value);
      }
    }

    const field = document.createElement("div");

    field.className = "cred-field";
    const label = document.createElement("label");
    label.textContent = "Your name for it";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.maxLength = 40;
    // NEVER PREFILLED FROM THE NICKNAME. A prefilled self-declared name
    // would let attacker-chosen words walk into the visor's voice by
    // accept-the-default — the user would "assign" a petname they never
    // wrote, and the visor would then speak it unquoted, which is exactly
    // the authority the whole three-name split exists to withhold. An
    // EXISTING petname is prefilled, because that one the user typed.
    input.value = surface.petname ?? "";
    input.placeholder = "a word you will recognise";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "the visor will use this name in its own voice; what the component calls itself stays quoted";
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
      "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and the name you choose is never given back to it";

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

    root.append(h, says, from);
    if (surface.firstSeen !== undefined) root.append(seen);
    if (surface.meta) root.append(meta);
    root.append(field, swatchLabel, swatchRow, note, reason, row);

    if (forgetBtn) root.append(forgetRow);
    return { root, input, saveBtn, cancelBtn, forgetBtn, reason, hue: () => picked };
  };

  const openNamingDrawer = (surface: SurfaceIdentity) => {
    // MUTUAL EXCLUSION is the host's: it refuses this open outright while
    // the exclusive credential tenant holds the drawer (a sheet that is
    // collecting — or about to accept — secrets is never displaced by a
    // naming ceremony), and it evicts the settings sheet and any previous
    // naming sheet, in that order, WITHOUT touching the strip context,
    // which this sheet is about to claim. The two LIGHTWEIGHT tenants
    // evict each other freely — neither holds anything a user would lose
    // by a click on the strip.
    const session = { surface, hue: surface.hue };
    namingTenant.open(session, () => {
      const built = buildNameSheet(surface, surface.hue);

      const finish = (status: string) => {
        closeNamingDrawer();
        // The visor's own line in the visor's own bar — not a pane's status
        // line: this is a statement about the shell's trust table, not
        // about anybody's replica. It expires by RE-RENDERING the strip
        // (see `announce`), which matters exactly here: the thing the
        // bottom line shows has just changed — a petname was assigned, or
        // a whole record was forgotten — so restoring what the line said
        // before would put a stale claim back on the anchor.
        if (status) announce(status);
      };

      built.saveBtn.onclick = () => {
        if (!namingTenant.owns(session)) return;
        const petname = built.input.value.trim();
        if (petname === "") {
          // Refused rather than treated as "forget": clearing the field is
          // an ambiguous gesture, and Cancel is the unambiguous way out.
          built.reason.textContent = "type a name, or Cancel to leave it unnamed";
          return;
        }
        const clash = petnameCollision(surface.name, petname);
        if (clash) {
          // The visor's own words, naming the colliding record by BOTH its
          // petname and its unforgeable provenance key — the user needs to
          // know which component already answers to this word.
          built.reason.textContent =
            `you already call another component "${clash.petname}" (fetched as ${clash.key}) — pick a different name`;
          return;
        }
        setPetname(surface.name, petname, built.hue());
        // The in-memory app surface is a CACHE of the record; the strip
        // renders from it, so a commit that only touched storage would
        // leave the anchor showing yesterday's answer.
        //
        // FIRST SIGHT IS OVER: the naming ceremony IS the TOFU moment
        // completing, so the NEW badge is cleared on every live copy of
        // this identity. "First time this component draws here —
        // recognition means nothing yet" and the user's own name for it
        // are contradictory claims to make side by side; once the user has
        // decided what to call it, they have done the recognising the
        // badge was asking for. (Forgetting is untouched: it deletes the
        // record, so the next mount is honestly NEW again.)
        if (appSurface && appSurface.name === surface.name) {
          appSurface = { ...appSurface, petname, hue: built.hue(), isNew: false };
        }
        if (activePanel && activePanel.surface.name === surface.name) {
          activePanel.surface = {
            ...activePanel.surface,
            petname,
            hue: built.hue(),
            isNew: false,
          };
        }
        // The session's own surface object: the sheet may outlive this
        // click (Save leaves it up only briefly, but the object is also
        // what a re-open would be built from).
        session.surface = { ...session.surface, petname, hue: built.hue(), isNew: false };
        finish(`saved — the visor will call this component ${petname} from now on`);
      };
      built.cancelBtn.onclick = () => {
        if (!namingTenant.owns(session)) return;
        finish("");
      };
      if (built.forgetBtn) {
        built.forgetBtn.onclick = () => {
          if (!namingTenant.owns(session)) return;
          forgetSurface(surface.name);
          // Forgetting must be honest on the strip too: the cached petname
          // goes with the record, so the anchor stops speaking a name
          // the visor no longer holds. (`isNew` stays as it is — this session
          // has seen the component; the NEXT mount is the one that is
          // genuinely new again, and the sheet says so.)
          if (appSurface && appSurface.name === surface.name) {
            appSurface = { ...appSurface, petname: undefined };
          }
          finish("forgotten — this component will be announced as NEW next time");
        };
      }

      // The height budget (the anchor must never be pushed off-screen by a
      // sheet that hangs off it) and the reveal are the host's.
      return {
        root: built.root,
        // No arming delay (see the naming tenant's spec): focus is given
        // immediately, because there is nothing here a mis-tap could spend.
        onShown: () => built.input.focus(),
      };
    });
  };

  /** The visor's settings sheet. EVERY string on it is the visor's own or the
   * user's own — there is no component in this interaction at all, which
   * makes it the only sheet with no foreign-quoted text anywhere. */
  const buildSettingsSheet = (rec: VisorIdentity, hueAtOpen: number) => {
    const root = document.createElement("div");
    // `.armed` from the start: there is no arming delay here (see the
    // settings tenant's spec), so the button row must never be drawn dimmed for
    // a wait that does not exist.
    root.className = "cred-sheet settings-sheet armed";
    root.style.maxWidth = "72rem"; // rem: aligns with the page's --content-max column
    root.style.marginLeft = "auto";
    root.style.marginRight = "auto";

    const h = document.createElement("h2");
    h.textContent = "Your visor";

    const lead = document.createElement("div");
    lead.className = "cred-line said";
    lead.textContent =
      "these are yours: the visor says them in its own voice, and no component is ever told them";

    // Both text fields are PREFILLED with the current value. That is the
    // same exception the naming sheet makes for an existing petname: the
    // prefill is the user's OWN prior word, not a self-declared name
    // walking into the visor's voice by accept-the-default.
    const mkField = (labelText: string, hint: string, value: string, id: string) => {
      const field = document.createElement("div");
      field.className = "cred-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      label.htmlFor = id;
      const input = document.createElement("input");
      input.id = id;
      input.type = "text";
      input.autocomplete = "off";
      input.maxLength = IDENTITY_MAX;
      input.value = value;
      const hintEl = document.createElement("div");
      hintEl.className = "hint";
      hintEl.textContent = hint;
      field.append(label, input, hintEl);
      return { field, input };
    };

    const nameField = mkField(
      "Your name",
      "shown at the right of this bar — leave it empty and the visor shows nothing there",
      rec.name ?? "",
      "visor-settings-name",
    );
    const deviceField = mkField(
      "This device",
      "your word for the machine you are on — e.g. laptop, study PC",
      rec.device ?? "",
      "visor-settings-device",
    );

    // The icon row: the visor's fixed vocabulary, nothing else (see
    // VISOR_ICONS — a free-text face could spoof words in the visor's
    // voice at the one position that cannot be spoofed).
    const iconLabel = document.createElement("div");
    iconLabel.className = "cred-line said";
    iconLabel.textContent = "the visor's mark on this bar";
    const iconRow = document.createElement("div");
    iconRow.className = "settings-icons";
    let pickedIcon = identityIcon(rec);
    const iconButtons: HTMLButtonElement[] = [];
    for (const glyph of VISOR_ICONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = glyph;
      b.dataset.glyph = glyph;
      b.title = `use ${glyph}`;
      b.classList.toggle("picked", glyph === pickedIcon);
      b.onclick = () => {
        pickedIcon = glyph;
        for (const other of iconButtons) other.classList.toggle("picked", other === b);
      };
      iconButtons.push(b);
      iconRow.append(b);
    }

    // The colour row, moved here whole from the old strip picker.
    // Constrained customisation: same lightness and chroma for every
    // choice, so contrast can never be customised away.
    const hueLabel = document.createElement("div");
    hueLabel.className = "cred-line said";
    hueLabel.textContent = "this bar's colour — yours, and never disclosed to an app";
    const hueRow = document.createElement("div");
    hueRow.className = "settings-hues";
    let pickedHue = hueAtOpen;
    const hueButtons: HTMLButtonElement[] = [];
    for (const hue of VISOR_HUES) {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = `oklch(38% .07 ${hue})`;
      b.dataset.hue = String(hue);
      b.title = `hue ${hue}`;
      b.classList.toggle("picked", hue === hueAtOpen);
      b.onclick = () => {
        pickedHue = hue;
        for (const other of hueButtons) other.classList.toggle("picked", other === b);
        // LIVE PREVIEW: the strip and this sheet repaint immediately, so
        // the user judges the anchor colour on the anchor rather than on
        // a swatch. Nothing is ANNOUNCED for this: the announced-reset
        // rule exists for changes the user did NOT make (a lost or
        // evicted record), and telling someone about the change they are
        // in the middle of making would devalue the announcement that
        // matters. Save commits it; Cancel puts it back.
        visor.applyHue(hue);
      };
      hueButtons.push(b);
      hueRow.append(b);
    }

    const note = document.createElement("div");
    note.className = "cred-note";
    note.textContent =
      "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and none of this is ever given to one";

    const row = document.createElement("div");
    row.className = "cred-row";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    row.append(saveBtn, cancelBtn);

    root.append(
      h,
      lead,
      nameField.field,
      deviceField.field,
      iconLabel,
      iconRow,
      hueLabel,
      hueRow,
      note,
      row,
    );
    return {
      root,
      nameInput: nameField.input,
      deviceInput: deviceField.input,
      saveBtn,
      cancelBtn,
      icon: () => pickedIcon,
      hue: () => pickedHue,
    };
  };

  const openSettingsDrawer = () => {
    // Precedence and eviction are the host's (see openNamingDrawer): the
    // credential tenant refuses this open outright, and the naming sheet
    // is evicted context-free.
    //
    // The committed colour: the anchor to revert to if this sheet does
    // not end in Save. Read from the visor's committed value rather than
    // re-reading storage, so a live preview from an earlier (evicted)
    // sheet can never be mistaken for the user's committed choice.
    const hueAtOpen = visor.committedHue();
    const session = { hueAtOpen };
    settingsTenant.open(session, () => {
      const built = buildSettingsSheet(visor.identity(), hueAtOpen);

      built.saveBtn.onclick = () => {
        if (!settingsTenant.owns(session)) return;
        visor.saveIdentity({
          name: built.nameInput.value,
          device: built.deviceInput.value,
          icon: built.icon(),
        });
        // Remember, paint, persist — in that order.
        visor.commitHue(built.hue());
        // The strip is repainted from the RECORD, not from the inputs, so
        // what the bar shows is exactly what was persisted (clamping and
        // the unset-is-absent rule included).
        visor.renderIdentity();
        closeSettingsDrawer({ commit: true });
      };
      built.cancelBtn.onclick = () => {
        if (!settingsTenant.owns(session)) return;
        // commit:false — the live colour preview is reverted (by the
        // tenant's own beforeCollapse) and the typed edits are simply
        // dropped with the sheet.
        closeSettingsDrawer();
      };

      return {
        root: built.root,
        // No arming delay (see the settings tenant's spec): focus goes
        // straight to the first field, because there is nothing here a
        // mis-tap could spend.
        onShown: () => built.nameInput.focus(),
      };
    });
  };

  /** Build the visor's sheet. Every word here is the visor's; the only foreign
   * strings are the component's name and the destination origin, both
   * quoted, clamped and foreign-styled. */
  const buildSheet = (session: CredentialSession, needs: string[]) => {    const root = document.createElement("div");
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
    // strip names it — the user's petname in the visor's voice when there is
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
    // Where `drawerNote` writes for as long as this sheet is up. The host
    // clears it on close, so a note aimed at a sheet that is gone cannot
    // land in the next one.
    visor.drawer.setNote(credReason);

    // THE VISOR'S OWN SIGN-IN CONTROL. It appears only when this session
    // actually needs both halves of the ceremony's inputs and outputs —
    // an app key to authorize against, and a bearer token to deposit.
    // It lives here rather than in the panel for the same reason the
    // fields do: it acts on the app key, and the app key is the visor's.
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
    session: CredentialSession,
    needs: string[],
    prefill: Record<string, string>,
    mismatch: boolean,
    /** The visor already holds an escrowed signing key for this session's
     * bound destination (looked up by the caller, under the same
     * binding the commit-time revalidation agreed on). */
    held: boolean,
  ) => {
    heldSigningKey = held;
    // The credential session takes the drawer from anything else holding
    // it — the host evicts the lightweight tenants context-free, because
    // they are interruptible conveniences and secret entry is not. The
    // caller has usually CLAIMED this same session object already (see
    // the storage Save handler), which the host reads as a claim being
    // revealed rather than a re-entry: nothing held is dropped.
    credentialTenant.open(session, () => {
      const { root, confirmBtn, cancelBtn, connectBtn } = buildSheet(session, needs);
      const refused = renderCredentials(needs, prefill);
      if (mismatch) {
        drawerNote("stored credentials are for a different destination — not filled");
      }

      confirmBtn.onclick = () => {
        const s = credentialTenant.session();
        if (!s) return;
        // Requiredness is the visor's rule, judged in the visor's pixels; the
        // panel is not told which credential was missing (it is gone).
        const missing = missingCredential();
        if (missing !== null) {
          drawerNote(`${missing} is required`);
          return;
        }
        // The visor merges its held values into the panel's secret-free
        // config — the same withCredentials path as before the drawer.
        // The S3 secret is NOT among them: it goes straight into the
        // keystore as a non-extractable handle and is never part of any
        // config object. Read the sheet's values HERE, because closing the
        // drawer drops them.
        const secret = heldCredential("secret-key").trim();
        const access = heldCredential("access-key").trim();
        const destination = s.destination;
        const full = withCredentials(s.cfg);
        closeDrawer();
        void (async () => {
          if (full.provider === "s3" && secret !== "") {
            // Non-empty = replace the held key; empty = keep it (the
            // field's placeholder said so, and requiredness agreed).
            // Escrow BEFORE persisting: a config that points at a
            // destination with no usable key is the one state worth
            // avoiding, since setup would then refuse.
            try {
              await putSigningKey(destination, access, secret);
            } catch (e) {
              tablet.status(`could not escrow the signing key: ${err(e)}`, true);
              return;
            }
          }
          persistAndConnect(full);
        })();
      };
      if (connectBtn) {
        const btn = connectBtn;
        btn.onclick = async () => {
          // The app key comes from THIS SHEET's own field, never from a
          // panel: the visor authorizes against what the user typed under the
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
            if (!credentialTenant.owns(session)) return;
            drawerNote("signed in ✓ — the token fields above were filled by the visor");
          } catch (e) {
            if (!credentialTenant.owns(session)) return;
            drawerNote(`sign-in failed: ${err(e)}`);
          } finally {
            if (credentialTenant.owns(session)) btn.disabled = false;
          }
        };
      }
      cancelBtn.onclick = () => {
        // Nothing was persisted and nothing was released: the held config
        // and the held credentials both die here.
        closeDrawer();
        tablet.status("storage setup cancelled — nothing saved", true);
      };

      return {
        root,
        // Disabled BEFORE the first frame, inputs included: a secret must
        // not be typeable into a sheet the user has not yet had time to
        // see. The host holds them disabled for ARM_MS.
        controls: [
          confirmBtn,
          cancelBtn,
          // The visor's sign-in control is armed by the SAME delay as the
          // rest: it opens a provider window, which is exactly the sort of
          // thing a baited mis-tap should not be able to reach.
          ...(connectBtn ? [connectBtn] : []),
          ...credInputs.values(),
        ],
        onArmed: () => {
          // Rule 3 still governs the inputs after arming: with no bound
          // destination there is nowhere to release to, so nothing may be
          // typed. (Refused kinds keep Confirm out of reach for good.)
          if (boundDestination === null) {
            for (const input of credInputs.values()) input.disabled = true;
          }
          if (refused) confirmBtn.disabled = true;
        },
      };
    });
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
      /** The surface mark the visor showed for this panel; the drawer
       * repeats it so "who asked" survives the panel's teardown. */
      surface: SurfaceIdentity;
    }
    | null = null;
  let panelDispatch: (ev: UiEvent) => void = () => {};
  /** The live panel surface's sandboxed frame, if any (see
   * frame-backend.ts). Teardown must destroy it explicitly: clearing the
   * region would orphan the port and the window listener. */
  let panelFrame: { destroy(): Promise<void> } | null = null;

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
  /** THE COMPLETION SIGNAL FOR THE LAST TEARDOWN — the thing this file's
   * late-teardown ordering class was missing a fourth time.
   *
   * The other three members of that class (the retirement observer's
   * `open`-attribute trigger, teardownPanel's session-aware context
   * restore, and the drawer's occupancy-checked timers) all exist
   * because a lifecycle step here finishes LATER than the code that
   * caused it returns. Frame teardown is the same shape and had no
   * signal at all: `destroy()` returned void, so a remount had no way to
   * ask "is the old surface actually gone?" and simply hoped. It is a
   * promise now (frame-backend.ts's `destroy`), and this holds the
   * in-flight one so `mountPanel` can await it.
   *
   * Null when no teardown is outstanding. */
  let teardownInFlight: Promise<void> | null = null;
  const teardownPanel = (): Promise<void> => {
    panelGeneration++;
    panelDispatch = () => {};
    // Close the port and drop the frame BEFORE clearing the region, so
    // the frame's window listener and MessagePort go with it rather than
    // being left holding a detached document.
    const gone = panelFrame?.destroy() ?? Promise.resolve();
    panelFrame = null;
    region.innerHTML = "";
    panelMounted = null;
    activePanel = null;
    // The strip goes back to whoever rightfully owns it now (see
    // restoreVisorContext): NOT unconditionally to the app, because the
    // dialog's close event/observer fires AFTER a handoff and would
    // otherwise blank a live sheet's line.
    restoreVisorContext();
    region.style.removeProperty("--component-color");
    saveBtn.disabled = false;
    dialogNote("");
    // Held credentials are PER-SESSION visor state: when the panel goes,
    // so do the values — UNLESS this teardown is the handoff into the
    // credential drawer, which is the one case where the visor must keep
    // holding them (the OAuth broker deposits during the panel session,
    // and the sheet that will show them opens a moment later). The drawer
    // clears them itself on Confirm or Cancel. Testing the credential session
    // rather than a transient flag matters because at least one embedding
    // delivers the dialog's `close` event LATE — after the drawer is
    // already up — and that stray teardown must not wipe the sheet.
    if (credentialTenant.session() === null) clearCredentials();
    // Publish the completion, and retire it once it lands so a later
    // mount does not await a teardown that finished long ago. The
    // identity check is the usual discipline: only the teardown that is
    // still the current one may clear the slot.
    const done = gone.then(() => {
      if (teardownInFlight === done) teardownInFlight = null;
    });
    teardownInFlight = done;
    return done;
  };

  const mountPanel = async (provider: "s3" | "dropbox") => {
    const gone = teardownPanel();
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
    // untrusted rectangle and its visor label visibly agree.
    // The mark is looked up by PROVENANCE (the visor fetched this artifact
    // itself, by this name, from its own origin) and assigned on first
    // sight — see surfaceMark.
    const { mark, isNew } = surfaceMark(name);
    const hue = mark.hue;
    // The component's colour is public (derived from its own bytes), but
    // scope it to the region anyway: the visor's document root stays clean.
    region.style.setProperty("--component-color", `oklch(62% .16 ${hue})`);
    // Before instantiation the visor has nothing but provenance to show, so
    // that is what it shows — the nickname is a claim only the running
    // component can make, and it lands a moment later.
    let identity: SurfaceIdentity = {
      name,
      nickname: name,
      hue,
      isNew,
      petname: mark.petname,
      firstSeen: mark.firstSeen,
    };
    setVisorContext(identity);

    // THE PREVIOUS SURFACE MUST BE ACTUALLY GONE before this one is
    // stood up. Teardown does not finish when `teardownPanel()` returns
    // — the old frame's window can still have messages in flight toward
    // the visor (frame-backend.ts's `destroy`), and creating the next frame
    // inside that window is how a stale delivery ends up attributed to
    // the new surface. Awaiting the completion is what turns "reopen
    // immediately after ESC" from a race into an ordering.
    await gone;
    // GENERATION AFTER EVERY AWAIT, this one included: two reopens in
    // the time the teardown took would leave this mount stale, and a
    // stale mount must not resurrect itself into a region a newer one
    // already owns.
    if (generation !== panelGeneration) return;
    if (!dialog.open) return;

    // Same sandboxed-frame treatment as the app panes: the panel handles
    // provider credentials, so the argument for keeping it out of
    // the visor's document is if anything stronger here.
    const frameBackend = createFrameBackend(region, (ev) => panelDispatch(ev), "dark");
    panelFrame = frameBackend;
    // A HANDSHAKE THAT NEVER COMPLETES BECAUSE WE WERE TORN DOWN IS
    // CANCELLATION, NOT FAILURE. `backend` rejects when the surface is
    // destroyed before it is ready, and an unguarded `await` turns that
    // into a thrown error — which openStorage's `.catch` then writes
    // into the region as "panel failed to mount: frame backend destroyed
    // before it was ready", clobbering whatever surface is legitimately
    // there by now. The generation is what distinguishes the two: if we
    // have been superseded, the rejection is our own retirement arriving
    // and this mount simply stops, silently.
    const backend = await frameBackend.backend.catch((e: unknown) => {
      if (generation !== panelGeneration) return null;
      throw e;
    });
    if (backend === null || generation !== panelGeneration) {
      await frameBackend.destroy();
      return;
    }
    const surface = createSurface(backend, () => "");
    // The capability profiles, side by side (#21): the S3 panel is PURE —
    // surface only, no egress. The Dropbox panel additionally holds
    // exactly ONE host-scoped fetch. It used to hold the OAuth broker
    // too; sign-in moved into the visor's drawer (where the app key is), so
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
      await frameBackend.destroy();
      return;
    }
    const panel = instance.exports as unknown as PanelExports;
    const runner = createRunner(surface);
    // WHAT THE COMPONENT CALLS ITSELF: read ONCE, here, and never again —
    // a name that could change under the visor's feet would be a name the visor
    // could not have shown the user before they acted on it. Clamped to
    // 40 at the read, exactly as `destination` is clamped at render, so
    // no downstream renderer has to remember. A hostile or broken panel
    // that traps, hangs the read, or answers with whitespace does NOT
    // take the visor down: the visor falls back to the provenance key it
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
    setVisorContext(identity);
    panelMounted = provider;
    // The visor keeps the handles it needs to COMMIT; the panel only ever
    // gets events and answers questions.
    activePanel = { provider, panel, runner, surface: identity };
    panelDispatch = (ev) => {
      if (panelMounted !== provider) return;
      runner.call(() => panel.onEvent(ev))
        // The binding is LIVE (#22 rule 2): the panel's configuration can
        // move under the visor's feet with any keystroke, so the visor re-reads
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
    // only. The visor's fields get the secrets (#22).
    const seedJson = stored && stored.provider === provider
      ? JSON.stringify(redactForPanel(stored))
      : "";
    await runner.call(() => panel.seed(seedJson));
    await runner.call(() => panel.run());
    if (generation !== panelGeneration) return;
    // The panel DECLARES its credential kinds. The visor does NOT render a
    // field here any more — entry happens later, in the visor's own drawer.
    // What the visor checks at mount is only whether it has WORDS for what
    // was asked: an unrecognised kind is refused up front and Save is
    // disabled, so the refusal cannot be clicked past into a sheet the visor
    // could not honestly label.
    const needs = await runner.call(() => panel.credentialNeeds());
    if (generation !== panelGeneration) return;
    const rawDest = await runner.call(() => panel.destination());
    if (generation !== panelGeneration) return;
    // note:false — this is the FIRST binding of the session, not a
    // change of one; there is nothing the user entered to invalidate.
    const bound = rebind(rawDest ?? "", { note: false });
    // The panel's DECLARED destination, carried on the identity so the
    // App settings sheet can show it. Component-INFLUENCED even after
    // the visor's normalization, hence foreign:true — the sheet quotes it.
    if (bound !== null) {
      identity = { ...identity, meta: { label: "declared destination", value: bound, foreign: true } };
      setVisorContext(identity);
      if (activePanel) activePanel.surface = identity;
    }

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
  //
  // BOTH PATHS ARE GUARDED ON `open` BEING FALSE AT THE MOMENT THEY RUN,
  // and that is the fourth member of this file's late-teardown ordering
  // class rather than a redundancy. The `close` event is delivered as a
  // TASK, so a reopen can land between the close and the event: the
  // event then arrives describing a session that is already over, while
  // a NEW surface is mid-handshake in the region. Retiring on it would
  // destroy that new frame before it was ready. A close event that finds
  // the dialog open again is by construction stale — its session ended,
  // and a later one has already begun — so it is dropped.
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    teardownPanel();
  });
  new MutationObserver(() => {
    if (!dialog.open && panelMounted !== null) teardownPanel();
  }).observe(dialog, { attributes: true, attributeFilter: ["open"] });

  // The visor's naming ceremony, reachable ONLY from the strip's own
  // pixels (see setVisorContext).
  const requestNaming = (surface: SurfaceIdentity) => {
    // The credential session wins: while secrets are on screen (or
    // arming) the drawer is not available for anything else.
    if (credentialTenant.isOpen()) return;
    // A modal <dialog> paints in the TOP LAYER — above the pinned visor
    // zone, and therefore above the sheet the strip would reveal. So the
    // ceremony takes the page back first: the panel is retired and the
    // dialog closed (the same retirement path ESC takes) BEFORE the visor's
    // own sheet appears. Naming outliving the panel session is correct
    // anyway — the name is a statement about the component, not about
    // this visit to its configuration.
    if (dialog.open) {
      teardownPanel();
      dialog.close();
    }
    openNamingDrawer(surface);
  };

  // The visor's settings sheet, reachable ONLY from the strip's own button
  // (rendered by the visor's identity cluster — visor pixels, unreachable from
  // any app rectangle).
  const requestSettings = () => {
    // Same precedence as naming, enforced twice: here, so a click on the
    // strip while secrets are up is a no-op, and again in the opener.
    if (credentialTenant.isOpen()) return;
    // A modal <dialog> paints in the TOP LAYER, above the visor zone and
    // so above the sheet the strip would reveal — the same reason the
    // naming ceremony takes the page back first.
    if (dialog.open) {
      teardownPanel();
      dialog.close();
    }
    openSettingsDrawer();
  };

  // THE STRIP'S LATE-BOUND CONTROLS. The strip is built by `initVisor`,
  // long before the drawer's tenants exist, so the "name it" affordance,
  // the context cluster and the settings button call through the visor's
  // handler slots. Installed here, once both ceremonies are defined.
  visor.install({ requestNaming, requestSettings });

  const openStorage = () => {
    // The dialog would paint over either lightweight sheet (top layer);
    // close them rather than leave a live sheet stranded behind a modal.
    closeNamingDrawer();
    closeSettingsDrawer();
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
  // The visor's Save: the commit belongs to the shell, so it is the visor that
  // asks the panel for a configuration and the visor that decides the
  // dialog is done. A panel refusing (none) leaves the dialog open with
  // its own explanation showing inside its region.
  //
  // PHASE 1 OF TWO. On success this does not connect: it takes the
  // secret-free config, retires the panel, closes the dialog, and hands
  // the interaction to the visor's credential drawer. Nothing is persisted
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
        // the panel could have re-pointed itself. So the visor re-reads the
        // destination NOW and holds it to three tests, in order — each
        // refusal in the visor's own words, dialog left open, NO drawer
        // opened and so no credential even askable for.
        const raw = await active.runner.call(() => active.panel.destination());
        if (activePanel !== active) return;
        const now = normalizeOrigin(raw ?? "");
        if (now === null) {
          dialogNote("no destination configured — credentials were not released");
          return;
        }
        if (now !== boundDestination) {
          // The binding the visor has been tracking is what the following
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
        // The visor asks ONE more time what the panel needs: the drawer's
        // fields are drawn from this answer, and it must be the answer
        // the committed configuration was produced with.
        const needs = (await active.runner.call(() => active.panel.credentialNeeds())) ?? [];
        if (activePanel !== active) return;
        const stored = loadStorage();
        // Prefill is decided BEFORE teardown, while the visor still knows
        // which provider produced this config (#22 rule 5, unchanged).
        const { prefill, mismatch } = credPrefill(stored, active.provider, now);
        // Does the visor already hold a signing key for THIS destination?
        // Keyed by the origin the revalidation above just agreed on, so
        // the destination binding governs this exactly as it governs
        // prefill: a panel pointing somewhere else finds nothing held.
        const held = active.provider === "s3" && (await getSigningKey(now)) !== null;
        if (activePanel !== active) return;
        // Anything the OAuth broker deposited during the panel session is
        // the visor's own capture of a ceremony the visor ran; it survives into
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
        // (and any late `close` event) leaves the held values alone. A
        // claim is state only: no sheet, no DOM, no context move.
        credentialTenant.claim(session);
        // ORDERING IS THE INVARIANT: the panel is retired and the dialog
        // is closed FIRST, so no component surface is alive on the page
        // when the credential sheet appears.
        teardownPanel();
        dialog.close();
        if (needs.length === 0) {
          // Nothing to ask for: no sheet, connect straight away.
          credentialTenant.claim(null);
          const full = withCredentials(cfg);
          clearCredentials();
          persistAndConnect(full);
          return;
        }
        openCredentialDrawer(session, needs, prefill, mismatch, held);
      })
      .catch((e) => console.warn(`[panel] commit: ${err(e)}`));
  };
  (document.getElementById("storage-cancel") as HTMLButtonElement).onclick = (ev) => {
    ev.preventDefault();
    teardownPanel();
    dialog.close();
  };

  const stored = loadStorage();
  // Migration runs FIRST: a config written before #11 still carries a
  // readable secret, which is escrowed and scrubbed here, so the setup
  // below finds a keystore entry instead of a field.
  await escrowPending(stored);
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
    // surface frame on the page must be UNREACHABLE from the visor's realm.
    // A sandboxed frame without `allow-same-origin` has an opaque origin,
    // so `contentDocument` is null (or throws) — if this ever reports
    // `sameOriginReachable: true`, the sandbox attribute has regressed
    // and the visor's pixels are once again in reach of component code.
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
    // The live credential binding, for driving: what the visor believes the
    // held values may be released toward (null = nothing may).
    boundDestination: () => boundDestination,
    // The credential sheet, for driving. `confirm`/`cancel` CLICK the
    // real buttons rather than calling the handlers, so a driver sees the
    // arming delay exactly as a user does: a click before ARM_MS lands on
    // a disabled button and does nothing.
    drawer: {
      open: () => credentialTenant.isOpen(),
      confirm: () =>
        (drawerInner.querySelector(".cred-row button:first-child") as
          | HTMLButtonElement
          | null)?.click(),
      cancel: () =>
        (drawerInner.querySelector(".cred-row button:last-child") as
          | HTMLButtonElement
          | null)?.click(),
    },
    // The visor's App settings sheet (the naming ceremony, grown), for
    // driving. `nameIt` clicks the strip's own control — visor pixels,
    // the only place the ceremony can start; `openCluster` clicks the
    // whole left cluster, which is the other way in.
    naming: {
      open: () => namingTenant.isOpen(),
      nameIt: () =>
        (document.getElementById("visor-name-it") as HTMLButtonElement | null)?.click(),
      openCluster: () =>
        (document.getElementById("visor-context") as HTMLElement | null)?.click(),
      /** Open the sheet for a named record directly — driving only, and
       * deliberately provenance-keyed: it opens for the surface the visor
       * already holds under that key, never for one synthesised from an
       * argument. Unknown keys open nothing. */
      openFor: (provenance: string) => {
        const known = [appSurface, activePanel?.surface].filter((s): s is SurfaceIdentity => !!s);
        const surface = known.find((s) => s.name === provenance);
        if (!surface) return false;
        requestNaming(surface);
        return true;
      },
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
    // The visor's settings sheet, for driving — mirrors `naming`.
    // `openSheet` CLICKS the strip's own button rather than calling the
    // opener, so a driver exercises the same path a user does (visor
    // pixels, the only place this ceremony can start).
    settings: {
      open: () => settingsTenant.isOpen(),
      openSheet: () =>
        (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click(),
      type: (field: "name" | "device", value: string) => {
        const id = field === "name" ? "visor-settings-name" : "visor-settings-device";
        const input = drawerInner.querySelector(`#${id}`) as HTMLInputElement | null;
        if (input) input.value = value;
      },
      pickIcon: (glyph: string) =>
        (drawerInner.querySelector(
          `.settings-icons button[data-glyph="${glyph}"]`,
        ) as HTMLButtonElement | null)?.click(),
      pickHue: (hue: number) =>
        (drawerInner.querySelector(
          `.settings-hues button[data-hue="${hue}"]`,
        ) as HTMLButtonElement | null)?.click(),
      save: () =>
        (drawerInner.querySelector(".settings-sheet .cred-row button:first-child") as
          | HTMLButtonElement
          | null)?.click(),
      cancel: () =>
        (drawerInner.querySelector(".settings-sheet .cred-row button:last-child") as
          | HTMLButtonElement
          | null)?.click(),
      identity: () => visor.identity(),
    },
    /** The app's own row in the trust table, as the visor registered it at
     * boot: provenance key, self-declared nickname, assigned mark, the
     * user's petname if any. Driving/inspection only. */
    appSurface: () => appSurface,
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
