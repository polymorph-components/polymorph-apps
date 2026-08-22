// The engine composite under polyengine: load the pre-translated envelope,
// assemble the import record (WASI batteries + the fetch-backed
// wasi:http fragment + the polymorph ports + the browser-profile
// sockets stub), and hand back typed views of the two exports.
//
// Every instance gets FRESH import fragments: the port modules' resource
// classes carry per-instance registry identity (polymorph-iroh
// host-deltic finding).

import { artifactsFromEnvelope, instantiate } from "@polyengine/runtime/embedder";
import { wasi } from "@polyengine/wasi";
import { http } from "@polyengine/wasi/http";
import { webcryptoImports } from "@polymorph/webcrypto-polyengine";
import { websocketImports } from "@polymorph/websocket-polyengine";
import { webrtcImports } from "@polymorph/webrtc-polyengine";
import { socketsImports } from "./stubs.ts";

const DRIVER = "polyvisor:engine/driver@0.1.0";
const TASKS = "polyvisor:tasks/tasks@0.1.0";

/** `store-config` — a WIT variant; `{kind, value}` per the value-mapping
 * convention below. ADDRESSING ONLY (#7/#11): no credential crosses this
 * boundary any more. Whether an instance can write, whose account it acts
 * as, and whether it can sign at all are properties of what its three
 * storage imports were WIRED to below — which config cannot see and must
 * not second-guess. The S3 access key stays because it is a public
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

  /** Publish/refresh the account's pointer to a data partition. The map
   * lives in the user-system doc, so it syncs; a freshly paired device
   * discovers the tasks partition by reading `usPartitions()`. */
  usPartitionPut(name: string, id: Uint8Array): Promise<void>;
  usPartitions(): Promise<UsPartition[]>;

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
// `[A, B]`, and a WIT variant/result case lowers to `{ kind: "case-name";
// value?: payload }` (no `value` key when the case has no payload) — the
// @polyengine/runtime value-mapping convention (embedder/values.ts, the
// authority; verified empirically against this composite, e.g.
// `driver.pairJoinStatus()` resolving `{"kind":"waiting"}`) — same
// convention the existing `StoreConfig` type above already uses.

export interface PairOffer {
  code: string;
  expiresMs: bigint;
}

export interface PairEnrollment {
  userGroupId: Uint8Array;
  partitionId: Uint8Array;
  /** THE ADDER'S IDS, AS THIS DEVICE OBSERVED THEM (engine.wit's
   * `pair-enrollment`). Pairing grants membership and stops; the
   * EMBEDDER owes the pair a sync path (PAIRING.md §2 step 7), and these
   * two are what it needs to dial: `irohStart(true, peerEndpointId,
   * relay, peerAgentId)` from the joiner.
   *
   * Neither is a name the peer claimed. The endpoint id is the
   * transport-authenticated dialer; the agent id is the issuer of the
   * signed delegation in the ENROLL card that made this device a member.
   *
   * They are NOT carried into the visor's `PairingDriver` contract
   * (visor/ui/pairing-driver.ts): the visor has no business dialling
   * anything, so the embedder reads them from the raw driver instead —
   * see runtime/pairing-engine.ts's `toMockJoinState`. */
  peerAgentId: Uint8Array;
  peerEndpointId: Uint8Array;
}

export type PairJoinState =
  | { kind: "waiting" }
  | { kind: "claimed"; value: string } // SAS — display, await pairJoinConfirm
  | { kind: "confirmed-waiting" }
  | { kind: "enrolled"; value: PairEnrollment }
  | { kind: "expired" }
  | { kind: "failed"; value: string };

export type PairAddState =
  | { kind: "connecting" }
  | { kind: "sas-ready"; value: string } // SAS — display, await pairAddConfirm
  | { kind: "waiting-peer" }
  | { kind: "enrolled" }
  | { kind: "failed"; value: string };

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

/** `us-partition` — a record, so it lowers to a plain object (the
 * `{kind, value}` variant convention above does not apply). `id` is a
 * keyhive doc id as raw bytes, matching every other `list<u8>` here;
 * `hex()`/`unhex()` below convert when a string is wanted. */
export interface UsPartition {
  name: string;
  id: Uint8Array;
}

export interface UsDevice {
  agentId: Uint8Array;
  name: string;
  enrolledAt: bigint;
  revoked: boolean;
}

export type UsEvent =
  | { kind: "profile-changed" }
  | { kind: "mark-added"; value: string } // provenance
  | { kind: "mark-changed"; value: string }
  | { kind: "mark-conflict-repaired"; value: [string, string] } // (provenance, "petname"|"icon")
  | { kind: "device-added"; value: string } // name
  | { kind: "device-revoked"; value: string };

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
  /** SigV4 over an escrowed non-extractable key (./keystore.ts). */
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
    "polyvisor:engine/store-fetch-types@0.1.0": {},
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
