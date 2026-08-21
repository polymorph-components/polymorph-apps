// The engine composite under deltic: load the pre-translated envelope,
// assemble the import record (WASI batteries + the fetch-backed
// wasi:http fragment + the sibling deltic ports + the browser-profile
// sockets stub), and hand back typed views of the two exports.
//
// Every instance gets FRESH import fragments: the port modules' resource
// classes carry per-instance registry identity (polymorph-iroh
// host-deltic finding).

import { artifactsFromEnvelope, instantiate } from "@deltic/runtime/embedder";
import { wasi } from "@deltic/wasi";
import { http } from "@deltic/wasi/http";
import { webcryptoImports } from "@polymorph/webcrypto-deltic";
import { websocketImports } from "@polymorph/websocket-deltic";
import { webrtcImports } from "@polymorph/webrtc-deltic";
import { socketsImports } from "./stubs.ts";

const DRIVER = "polymorph:engine/driver@0.1.0";
const TASKS = "polymorph-data:tasks/tasks@0.1.0";

/** `store-config` — a WIT variant; `{tag, val}` per the value-mapping
 * table. ADDRESSING ONLY (#7/#11): no credential crosses this boundary
 * any more. Whether an instance can write, whose account it acts as, and
 * whether it can sign at all are properties of what its three storage
 * imports were WIRED to below — which config cannot see and must not
 * second-guess. The S3 access key stays because it is a public
 * identifier that travels in the Authorization header in clear. */
export type StoreConfig =
  | {
    kind: "s3";
    value: { endpoint: string; bucket: string; accessKey: string };
  }
  | {
    kind: "dropbox";
    value: { root: string };
  };

// WIT `result<T, string>` returns resolve T / throw ComponentException.
export interface Driver {
  init(exportableIdentity: boolean): Promise<string>;
  khKnowsAgent(agentId: Uint8Array): Promise<boolean>;
  khCreateGroup(): Promise<Uint8Array>;
  khAddToGroup(groupId: Uint8Array, memberId: Uint8Array, level: string): Promise<void>;
  khRevokeFromGroup(groupId: Uint8Array, memberId: Uint8Array): Promise<void>;
  khExportCard(agentId: Uint8Array): Promise<Uint8Array>;
  khIngestCard(card: Uint8Array): Promise<number>;
  khAddMember(docId: Uint8Array, agentId: Uint8Array, level: string): Promise<void>;
  khRevokeMember(docId: Uint8Array, agentId: Uint8Array): Promise<void>;
  khContactCard(): Promise<Uint8Array>;
  khIngestContact(card: Uint8Array): Promise<void>;
  irohBind(relayUrl: string): Promise<string>;
  irohStart(
    initiator: boolean,
    peerEndpointId: Uint8Array,
    relayUrl: string,
    expectedPeer: Uint8Array,
  ): Promise<number>;
  connStatus(conn: number): Promise<string | undefined>;
  syncStart(peer: Uint8Array, tree: Uint8Array, subscribe: boolean): Promise<number>;
  syncStatus(handle: number): Promise<string | undefined>;
  createPartition(): Promise<Uint8Array>;
  sealPartition(id: Uint8Array): Promise<void>;
  adoptPartition(id: Uint8Array): Promise<void>;
  chunkStats(id: Uint8Array): Promise<[number, number]>;
  initStore(config: StoreConfig): Promise<void>;
  ensureBucket(): Promise<void>;
  /** S3: none. Dropbox: the member's minted pickup link — their standing
   * capability, carried by the caller in lieu of the E2E channel. */
  storeGrant(docId: Uint8Array, memberId: Uint8Array): Promise<string | undefined>;
  /** Human-readable guarantee note (cooperative vs. server-side hard). */
  storeRevoke(docId: Uint8Array, memberId: Uint8Array): Promise<string>;
  bucketFlush(docId: Uint8Array): Promise<string>;
  /** `pickup` is the link-tier standing capability; owner tiers ignore it. */
  bucketPull(
    docId: Uint8Array,
    ownerId: Uint8Array,
    pickup: string | undefined,
  ): Promise<string>;
  identityExport(
    label: string,
    passphrase: string | undefined,
    secretSlot: Uint8Array | undefined,
  ): Promise<Uint8Array>;
  identityImport(
    bundle: Uint8Array,
    passphrase: string | undefined,
    secret: Uint8Array | undefined,
  ): Promise<string>;

  // --- device pairing (#10) + user-system (#36) --- (engine.wit ~214-280)

  pairJoinStart(): Promise<PairOffer>;
  pairJoinStatus(): Promise<PairJoinState>;
  pairJoinConfirm(): Promise<void>;

  pairAddStart(code: string): Promise<void>;
  pairAddStatus(): Promise<PairAddState>;
  /** device-name: the user's own word for the new device, recorded in
   * the devices annotations by the ADDER (engine.wit's pair-add-confirm
   * doc comment). */
  pairAddConfirm(deviceName: string): Promise<void>;

  pairAbort(): Promise<void>;

  /** First device only: create user group + user-system partition,
   * write the initial profile. Returns the user group id. */
  userCreate(profile: UsProfile): Promise<Uint8Array>;

  usProfileGet(): Promise<UsProfile>;
  usProfileSet(profile: UsProfile): Promise<void>;

  usMarksList(): Promise<UsMark[]>;
  usMarkPut(mark: UsMark): Promise<void>;
  usMarkForget(provenance: string): Promise<void>;
  usMarkConfirm(provenance: string): Promise<void>;

  usContactsList(): Promise<Array<[Uint8Array, string]>>;
  usContactPut(card: Uint8Array, petname: string): Promise<void>;

  usDevicesList(): Promise<UsDevice[]>;
  usDeviceRevoke(agentId: Uint8Array): Promise<void>;

  /** Drain remotely-caused changes the visor must announce (#22).
   * Local-echo suppression is engine-side: a device never receives
   * events for its own writes. */
  usEvents(): Promise<UsEvent[]>;

  stats(): Promise<string>;
}

// --- device-pairing + user-system WIT record/variant mirrors
// (engine.wit ~214-280). `option<T>` lowers to `T | undefined`, `list<u8>`
// to Uint8Array, `u64` to bigint, `u16`/`u32` to number, `tuple<A, B>` to
// `[A, B]`, and a no-payload variant case to `{ tag: "case-name" }` — same
// conventions the existing Driver/Tasks types above already use.

export interface PairOffer {
  code: string;
  expiresMs: bigint;
}

export interface PairEnrollment {
  userGroupId: Uint8Array;
  partitionId: Uint8Array;
}

export type PairJoinState =
  | { tag: "waiting" }
  | { tag: "claimed"; val: string } // SAS — display, await pairJoinConfirm
  | { tag: "confirmed-waiting" }
  | { tag: "enrolled"; val: PairEnrollment }
  | { tag: "expired" }
  | { tag: "failed"; val: string };

export type PairAddState =
  | { tag: "connecting" }
  | { tag: "sas-ready"; val: string } // SAS — display, await pairAddConfirm
  | { tag: "waiting-peer" }
  | { tag: "enrolled" }
  | { tag: "failed"; val: string };

export interface UsProfile {
  displayName: string;
  hue: number; // OKLCH hue index per #22 palette (u16)
  icon?: Uint8Array;
}

export interface UsMark {
  provenance: string;
  petname: string;
  /** The pet-icon glyph (engine.wit's `us-mark.icon`), or "" for
   * unmarked. Opaque to the engine — repair is exact-equality only; the
   * curated vocabulary and its confusability rules are the visor's
   * (visor/ui/visor.ts's APP_MARK_ICONS). Was `hue: u16` (#22). */
  icon: string;
  nickname?: string;
  createdAt: bigint;
  needsReconfirm: boolean; // set by conflict repair; cleared by usMarkConfirm
}

export interface UsDevice {
  agentId: Uint8Array;
  name: string;
  enrolledAt: bigint;
  revoked: boolean;
}

export type UsEvent =
  | { tag: "profile-changed" }
  | { tag: "mark-added"; val: string } // provenance
  | { tag: "mark-changed"; val: string }
  | { tag: "mark-conflict-repaired"; val: [string, string] } // (provenance, "petname"|"icon")
  | { tag: "device-added"; val: string } // name
  | { tag: "device-revoked"; val: string };

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
}

export interface Snapshot {
  revision: bigint;
  items: TodoItem[];
}

export interface Tasks {
  partition(): Promise<Uint8Array>;
  revision(): Promise<bigint>;
  items(): Promise<Snapshot>;
  add(title: string): Promise<string>;
  setCompleted(id: string, completed: boolean): Promise<void>;
  setTitle(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface Engine {
  driver: Driver;
  tasks: Tasks;
  stdout(): string;
  stderr(): string;
}

export interface EngineArtifacts {
  envelope: string;
  bytes: Uint8Array;
}

/** One storage-egress seam: the shape of `store-owner-fetch.request` and
 * `store-public-fetch.request` (the same WIT interface type under two
 * import names — the memo's whole mechanism). A refusal is the err side
 * of `result<response, string>`: a branded ComponentException, not a
 * trap, so the guest can observe a denied egress. */
export type StoreFetch = (
  method: string,
  url: string,
  headers: Array<[string, string]>,
  body: Uint8Array,
) => Promise<{ status: number; body: Uint8Array }>;

/** `store-signer.sign`: public request metadata in, one lowercase-hex
 * signature out. Key material crosses in neither direction. */
export type StoreSign = (
  stringToSign: string,
  date: string,
  region: string,
  service: string,
) => Promise<string>;

/**
 * THE PER-INSTANCE STORAGE AUTHORITY (#7 "authority in the instance,
 * selection by import name"). The engine composite imports three named
 * seams; what each one is wired to IS the grant. Two instances of the
 * same bytes with different `net` are a writer and a reader, and the
 * difference is legible in the wiring rather than in whether some config
 * field happened to be left blank.
 */
export interface EngineNet {
  /** Acts as the user: signs (S3) or injects the held bearer (Dropbox). */
  ownerFetch: StoreFetch;
  /** Carries no identity, ever: strips authorization, injects nothing. */
  publicFetch: StoreFetch;
  /** Carries the APP's identity and never the user's: Dropbox demands an
   * authenticated caller for shared-link reads, but app auth identifies
   * the shipped client, not the person holding it. Its own import is
   * what makes recipient anonymity structural — the user's bearer is
   * wired elsewhere and cannot reach this path. */
  sharedFetch: StoreFetch;
  /** SigV4 over an escrowed non-extractable key (host/keystore.ts). */
  signer: StoreSign;
}

export async function newEngine(
  label: string,
  artifacts: EngineArtifacts,
  net: EngineNet,
): Promise<Engine> {
  const shims = wasi({ cli: { args: [`engine-${label}`] } });
  const imports = {
    ...shims,
    // The generic fetch-backed wasi:http fragment stays: the composite no
    // longer routes storage through it, and anything else that wants HTTP
    // is unaffected by this retrofit.
    ...http().imports,
    ...webcryptoImports(),
    ...websocketImports(),
    ...webrtcImports(),
    ...socketsImports(),
    // The three storage seams, by IMPORT NAME. Attaching the wrong
    // authority is inexpressible here rather than checked at request
    // time: a call site that wants the user's identity had to be written
    // against `store-owner-fetch` when the guest was compiled.
    "store-owner-fetch": { request: net.ownerFetch },
    "store-public-fetch": { request: net.publicFetch },
    "store-shared-fetch": { request: net.sharedFetch },
    "store-signer": { sign: net.signer },
    // The shared `response` record's interface is TYPE-ONLY, and the
    // translated plan elides it entirely (verified: the plan's import
    // list holds `store-owner-fetch`, `store-public-fetch` and
    // `store-signer`, and no `store-fetch-types` entry). This empty
    // record is therefore a no-op today, kept because a superfluous
    // import key is ignored — the same reason the wasi:http fragment
    // above can stay — whereas a missing one would be fatal if a future
    // translator does surface it.
    "polymorph:engine/store-fetch-types@0.1.0": {},
  };
  const instance = await instantiate(
    artifactsFromEnvelope(artifacts.envelope, artifacts.bytes),
    imports,
  );
  const driver = instance.exports[DRIVER] as unknown as Driver;
  const tasks = instance.exports[TASKS] as unknown as Tasks;
  if (!driver || typeof driver.init !== "function") {
    throw new Error(
      `export "${DRIVER}" missing or shapeless; exports: ${
        Object.keys(instance.exports).join(", ")
      }`,
    );
  }
  return {
    driver,
    tasks,
    stdout: () => shims.captured.stdoutText(),
    stderr: () => shims.captured.stderrText(),
  };
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Poll until `f` returns a truthy value or the deadline passes. */
export async function until<T>(
  what: string,
  f: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
  intervalMs = 25,
): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (performance.now() - t0 > timeoutMs) {
      throw new Error(`timeout: ${what}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
