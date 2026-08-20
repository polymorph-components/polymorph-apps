// Mock device-pairing + user-system driver (Track B, #10/#36).
//
// Implements the async surface pinned in
// ../../tasks-engine/PAIRING.md §3 ("WIT additions") in TypeScript,
// behind the exact same function names the real engine composite will
// export once Track A lands. Swapping this module for a thin adapter
// over the real `driver` export is the whole integration step — nothing
// in host/pairing-visor.ts is aware this is a mock.
//
// WHAT IS MOCKED, DELIBERATELY:
//   - Transport: an in-page "network" object shared by every mock
//     instance stands in for the iroh pairing stream (§2). Two panes
//     that hold a reference to the SAME MockPairingNetwork behave like
//     two devices on the real wire: a code offered by one is claimable
//     by the other, and both compute the same SAS from the same
//     transcript.
//   - Hash: the transcript is hashed with SHA-256 (Web Crypto,
//     synchronously available in every target) instead of BLAKE3. The
//     contract (§2) only requires that BOTH sides derive the SAME value
//     from the same transcript, which SHA-256 gives identically; BLAKE3
//     is an engine-side dependency this mock has no reason to vendor.
//     The digit derivation itself (first 4 bytes of the hash, u32 BE,
//     mod 10^6, zero-padded to 6 digits) is exactly the contract's
//     formula (§2) — only the hash function differs, and the mock's
//     hash is 32 bytes, so "first 4 bytes" reads identically over it.
//   - Sync fan-out: the user-system "doc" is a plain JS object shared by
//     reference across every mock instance that has adopted the same
//     user-group-id. A real doc is CRDT-merged across a network; this
//     mock skips convergence because every instance already shares the
//     same object, which is sufficient to develop the visor's reconcile/
//     announce paths without also faking automerge.
//   - Marks conflict repair (§4) is implemented for the two cases the
//     contract states (petname collision, hue collision) so
//     mark-conflict-repaired has something real to fire on.
//
// Nothing here is visor. This module knows nothing about DOM, strips,
// sheets or ceremonies — see host/pairing-visor.ts, which is the ONLY
// module allowed to render a pairing code or a SAS (invariant (f) in
// scripts/check-invariants.sh).

// --- WIT record/variant mirrors (PAIRING.md §3, verbatim shapes) -----------

export interface PairOffer {
  code: string;
  expiresMs: number;
}

export interface PairEnrollment {
  userGroupId: string;
  partitionId: string;
}

export type PairJoinState =
  | { tag: "waiting" }
  | { tag: "claimed"; sas: string }
  | { tag: "confirmed-waiting" }
  | { tag: "enrolled"; enrollment: PairEnrollment }
  | { tag: "expired" }
  | { tag: "failed"; message: string };

export type PairAddState =
  | { tag: "connecting" }
  | { tag: "sas-ready"; sas: string }
  | { tag: "waiting-peer" }
  | { tag: "enrolled" }
  | { tag: "failed"; message: string };

export interface UsProfile {
  displayName: string;
  hue: number;
  icon?: Uint8Array;
}

export interface UsMark {
  provenance: string;
  petname: string;
  hue: number;
  nickname?: string;
  createdAt: number;
  needsReconfirm: boolean;
}

export interface UsDevice {
  agentId: string;
  name: string;
  enrolledAt: number;
  revoked: boolean;
}

export type UsEvent =
  | { tag: "profile-changed" }
  | { tag: "mark-added"; provenance: string }
  | { tag: "mark-changed"; provenance: string }
  | { tag: "mark-conflict-repaired"; provenance: string; field: "petname" | "hue" }
  | { tag: "device-added"; name: string }
  | { tag: "device-revoked"; name: string };

/** The async, WIT-shaped surface every mock instance (and, later, the
 * real composite's adapter) implements. Visor code is written against
 * exactly this interface. */
export interface PairingDriver {
  pairJoinStart(): Promise<{ ok: true; value: PairOffer } | { ok: false; error: string }>;
  pairJoinStatus(): Promise<{ ok: true; value: PairJoinState } | { ok: false; error: string }>;
  pairJoinConfirm(): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  pairAddStart(code: string): Promise<{ ok: true; value: null } | { ok: false; error: string }>;
  pairAddStatus(): Promise<{ ok: true; value: PairAddState } | { ok: false; error: string }>;
  pairAddConfirm(
    deviceName: string,
  ): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  pairAbort(): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  userCreate(profile: UsProfile): Promise<{ ok: true; value: string } | { ok: false; error: string }>;

  usProfileGet(): Promise<{ ok: true; value: UsProfile } | { ok: false; error: string }>;
  usProfileSet(profile: UsProfile): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  usMarksList(): Promise<{ ok: true; value: UsMark[] } | { ok: false; error: string }>;
  usMarkPut(mark: UsMark): Promise<{ ok: true; value: null } | { ok: false; error: string }>;
  usMarkForget(provenance: string): Promise<{ ok: true; value: null } | { ok: false; error: string }>;
  usMarkConfirm(provenance: string): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  usContactsList(): Promise<
    { ok: true; value: Array<[string, string]> } | { ok: false; error: string }
  >;
  usContactPut(
    card: string,
    petname: string,
  ): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  usDevicesList(): Promise<{ ok: true; value: UsDevice[] } | { ok: false; error: string }>;
  usDeviceRevoke(agentId: string): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  /** Drain remotely-caused changes (local-echo suppressed at the
   * network layer, matching the contract's "a device never receives
   * events for its own writes"). */
  usEvents(): Promise<{ ok: true; value: UsEvent[] } | { ok: false; error: string }>;
}

// --- the shared user-system "doc" ------------------------------------------

interface UserGroupDoc {
  profile: UsProfile;
  marks: Map<string, UsMark>;
  contacts: Map<string, string>;
  devices: Map<string, UsDevice>;
  /** Per-instance-id drained event queues (§4: "per-instance drained
   * queue"). Keyed by the instance whose driver call should see them
   * next; every OTHER instance's write pushes here, never the writer's
   * own (local-echo suppression, per contract). */
  eventQueues: Map<string, UsEvent[]>;
}

function freshGroupDoc(profile: UsProfile): UserGroupDoc {
  return {
    profile,
    marks: new Map(),
    contacts: new Map(),
    devices: new Map(),
    eventQueues: new Map(),
  };
}

function broadcast(doc: UserGroupDoc, from: string, ev: UsEvent) {
  for (const id of doc.eventQueues.keys()) {
    if (id === from) continue; // local-echo suppression
    doc.eventQueues.get(id)!.push(ev);
  }
}

function ensureQueue(doc: UserGroupDoc, instanceId: string) {
  if (!doc.eventQueues.has(instanceId)) doc.eventQueues.set(instanceId, []);
}

// --- marks invariants + deterministic repair (§4) --------------------------

// Hues are PALETTE INDICES (PAIRING.md §4: "u16 index into the #22
// framework palette, ~10 entries"), not raw OKLCH angles — the mock
// carries the same u16 index space the WIT type promises; the
// index-to-angle mapping is the visor's own table (host/pairing-visor.ts
// mirrors host/demo.ts's existing VISOR_HUES), never the mock's
// concern.
const PALETTE_SIZE = 10;

/** Runs after every write that could have introduced a collision. Older
 * record wins (`createdAt`, tie-break lexicographic provenance); the
 * loser is repaired in place and a `mark-conflict-repaired` event is
 * broadcast, matching §4's "repair writes only from the device that
 * observes a violation involving its OWN losing write; others render
 * the computed outcome without writing" — since this mock's doc is one
 * shared object, "observing" and "repairing" collapse to the same
 * synchronous step, which still yields the same deterministic outcome
 * every instance would compute independently over the real CRDT. */
function repairMarks(doc: UserGroupDoc, instanceId: string) {
  const byPetname = new Map<string, UsMark[]>();
  const byHue = new Map<number, UsMark[]>();
  for (const m of doc.marks.values()) {
    const pk = m.petname.toLowerCase();
    if (!byPetname.has(pk)) byPetname.set(pk, []);
    byPetname.get(pk)!.push(m);
    if (!byHue.has(m.hue)) byHue.set(m.hue, []);
    byHue.get(m.hue)!.push(m);
  }
  const older = (a: UsMark, b: UsMark) =>
    a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.provenance.localeCompare(b.provenance);

  for (const group of byPetname.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(older);
    for (const loser of sorted.slice(1)) {
      if (!loser.needsReconfirm) {
        loser.needsReconfirm = true;
        broadcast(doc, instanceId, {
          tag: "mark-conflict-repaired",
          provenance: loser.provenance,
          field: "petname",
        });
      }
    }
  }
  for (const [, group] of byHue) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(older);
    // Free/used indices are GLOBAL across the whole doc (every mark's
    // current hue), not just this colliding group — a reassignment must
    // not land on an index some other, non-colliding mark already
    // holds. Recomputed per loser so an earlier reassignment in this
    // same pass is accounted for before picking the next one.
    for (const loser of sorted.slice(1)) {
      const used = new Set(
        [...doc.marks.values()].filter((m) => m !== loser).map((m) => m.hue),
      );
      // Smallest UNUSED INDEX, not pool/iteration order (§4: "the
      // smallest unused palette index").
      let next: number | undefined;
      for (let i = 0; i < PALETTE_SIZE; i++) {
        if (!used.has(i)) {
          next = i;
          break;
        }
      }
      if (next === undefined) {
        // Palette exhausted: §4 — "the collision stands (matches
        // assignment-time behaviour — uniqueness is only promisable
        // while unused hues exist)". No reassignment, no event, no
        // write: the loser keeps its colliding hue exactly as-is.
        continue;
      }
      loser.hue = next;
      broadcast(doc, instanceId, {
        tag: "mark-conflict-repaired",
        provenance: loser.provenance,
        field: "hue",
      });
    }
  }
}

// --- the "network": pairing offers shared across mock instances -----------

interface PendingOffer {
  code: string;
  token: string;
  joinEndpointId: string;
  joinInstanceId: string;
  expiresAt: number;
  claimed: boolean;
  /** Set once an adder claims the offer; the join side polls for it. */
  claim?: {
    addInstanceId: string;
    addEndpointId: string;
    nonceA: string;
    commit: string;
    sas?: string;
    joinConfirmed: boolean;
    addConfirmed: boolean;
    /** device-name from the ADDER (§3: "recorded... by the ADDER"). */
    deviceName?: string;
    aborted: boolean;
    /** Once true, ENROLL has fired: the join side may report `enrolled`. */
    enrolled: boolean;
  };
}

const BASE32_VISUAL = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // BASE32_NOPAD_VISUAL alphabet (confusable-free)

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += BASE32_VISUAL[b % BASE32_VISUAL.length];
  return out;
}

/** Format §1's fixed-width payload into the display code. This mock
 * does not bit-pack version/endpoint-id/token into 33 bytes (79 chars of
 * BASE32_NOPAD_VISUAL over 33 bytes, per §1's arithmetic) because
 * nothing on the mock side needs to DECODE the code — only look it up in
 * the shared network by exact string match, matching the real protocol's
 * "the adder dials the endpoint id from the code" without needing an
 * actual endpoint id. The LENGTH (79) and ALPHABET are real: the visor's
 * grouped-by-4 rendering and the join/add code fields are built and
 * tested against production dimensions. */
function makeCode(): string {
  // 33 raw bytes -> ceil(33*8/5) = 53 symbols is base32's true ratio;
  // the contract states 79 chars for its specific 1+32+16 = 49-byte
  // payload (49*8/5 = 78.4 -> 79 with padding). Mirror 79 directly so
  // the visor's "groups of 4" renderer is exercised against the real length.
  let out = "";
  while (out.length < 79) out += randomToken(8);
  return out.slice(0, 79);
}

async function sha256Hex(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join("\u0000"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** (first 4 bytes of hash, u32 big-endian) mod 10^6, zero-padded to 6
 * digits — PAIRING.md §2's formula exactly, over a SHA-256 transcript
 * hash instead of BLAKE3 (see the sanctioned deviation noted at the
 * top of this file). */
function sasFromHash(hex: string): string {
  const u32be = parseInt(hex.slice(0, 8), 16); // first 4 bytes, big-endian
  return String(u32be % 1_000_000).padStart(6, "0");
}

export class MockPairingNetwork {
  private offers = new Map<string, PendingOffer>();
  /** instanceId -> userGroupId this instance has adopted. */
  private membership = new Map<string, string>();
  private groups = new Map<string, UserGroupDoc>();
  /** instanceId -> display name (for devices-list entries and the
   * demo's own bookkeeping; not part of the WIT surface). */
  instanceLabel = new Map<string, string>();

  /** Called once per instance so its event queue exists even before it
   * joins a group (kept simple: queues live on the group doc, so this
   * is a no-op placeholder for symmetry / future per-instance state). */
  registerInstance(instanceId: string, label: string) {
    this.instanceLabel.set(instanceId, label);
  }

  groupFor(instanceId: string): UserGroupDoc | undefined {
    const gid = this.membership.get(instanceId);
    return gid ? this.groups.get(gid) : undefined;
  }

  createGroup(instanceId: string, profile: UsProfile): string {
    const gid = randomToken(16);
    const doc = freshGroupDoc(profile);
    ensureQueue(doc, instanceId);
    this.groups.set(gid, doc);
    this.membership.set(instanceId, gid);
    return gid;
  }

  startOffer(instanceId: string): PairOffer {
    const code = makeCode();
    const offer: PendingOffer = {
      code,
      token: randomToken(16),
      joinEndpointId: randomToken(32),
      joinInstanceId: instanceId,
      expiresAt: Date.now() + 120_000,
      claimed: false,
    };
    this.offers.set(code, offer);
    return { code, expiresMs: 120_000 };
  }

  getOffer(code: string): PendingOffer | undefined {
    return this.offers.get(code);
  }

  /** CLAIM (§2 step 1). Single-claim: a second CLAIM on an
   * already-claimed offer is refused with a distinct error so the
   * joiner UI can say "someone already tried this code". */
  claim(
    code: string,
    addInstanceId: string,
  ): { ok: true } | { ok: false; error: "not-found" | "expired" | "claimed" } {
    const offer = this.offers.get(code);
    if (!offer) return { ok: false, error: "not-found" };
    if (Date.now() > offer.expiresAt) return { ok: false, error: "expired" };
    if (offer.claimed) return { ok: false, error: "claimed" };
    offer.claimed = true;
    offer.claim = {
      addInstanceId,
      addEndpointId: randomToken(32),
      nonceA: randomToken(16),
      commit: "", // unused: the mock has no separate CLAIM/REVEAL round (see the nonce_j stand-in note below)
      joinConfirmed: false,
      addConfirmed: false,
      aborted: false,
      enrolled: false,
    };
    return { ok: true };
  }

  async computeSas(code: string): Promise<string | undefined> {
    const offer = this.offers.get(code);
    if (!offer?.claim) return undefined;
    if (offer.claim.sas) return offer.claim.sas;
    const transcript = [
      "\x01",
      offer.token,
      offer.joinEndpointId,
      offer.claim.addEndpointId,
      offer.claim.nonceA, // stand-in nonce_j: mock has no separate reveal round
      offer.claim.nonceA,
    ];
    const hex = await sha256Hex(transcript);
    offer.claim.sas = sasFromHash(hex);
    return offer.claim.sas;
  }

  confirmJoin(code: string) {
    const offer = this.offers.get(code);
    if (offer?.claim) offer.claim.joinConfirmed = true;
  }

  confirmAdd(code: string, deviceName: string) {
    const offer = this.offers.get(code);
    if (offer?.claim) {
      offer.claim.addConfirmed = true;
      offer.claim.deviceName = deviceName;
    }
  }

  abort(code: string) {
    const offer = this.offers.get(code);
    if (offer?.claim) offer.claim.aborted = true;
  }

  /** ENROLL (§2 step 6): only after BOTH confirms. Adds the joiner's
   * instance to the same group doc and emits `device-added`. Returns
   * the enrollment payload the join side reports. */
  tryEnroll(code: string): PairEnrollment | undefined {
    const offer = this.offers.get(code);
    if (!offer?.claim || offer.claim.enrolled) return undefined;
    if (!offer.claim.joinConfirmed || !offer.claim.addConfirmed) return undefined;
    const gid = this.membership.get(offer.claim.addInstanceId);
    if (!gid) return undefined;
    const doc = this.groups.get(gid)!;
    this.membership.set(offer.joinInstanceId, gid);
    ensureQueue(doc, offer.joinInstanceId);
    const agentId = randomToken(16);
    const dev: UsDevice = {
      agentId,
      name: offer.claim.deviceName ?? "",
      enrolledAt: Date.now(),
      revoked: false,
    };
    doc.devices.set(agentId, dev);
    broadcast(doc, offer.joinInstanceId, { tag: "device-added", name: dev.name });
    offer.claim.enrolled = true;
    return { userGroupId: gid, partitionId: gid };
  }
}

// --- per-instance driver ---------------------------------------------------

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
function err(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Build a PairingDriver for one mock "device". `instanceId` must be
 * unique per pane; `net` must be the SAME MockPairingNetwork instance
 * shared with whatever other pane(s) should be reachable by pairing. */
export function createMockDriver(instanceId: string, net: MockPairingNetwork): PairingDriver {
  net.registerInstance(instanceId, instanceId);

  // join-side session state (this instance is the NEW device).
  let joinCode: string | undefined;
  let joinState: PairJoinState = { tag: "waiting" };

  // add-side session state (this instance is the TRUSTED device).
  let addCode: string | undefined;
  let addState: PairAddState = { tag: "connecting" };

  const driver: PairingDriver = {
    async pairJoinStart() {
      const offer = net.startOffer(instanceId);
      joinCode = offer.code;
      joinState = { tag: "waiting" };
      return ok(offer);
    },

    async pairJoinStatus() {
      if (!joinCode) return err("no offer started");
      const offer = net.getOffer(joinCode);
      if (!offer) return err("offer not found");
      if (offer.claim?.aborted) {
        joinState = { tag: "failed", message: "the other device cancelled" };
        return ok(joinState);
      }
      if (offer.claim?.enrolled) {
        // tryEnroll only sets enrolled after ENROLL is sent; before
        // that the join side must keep polling.
      }
      const enrollment = net.tryEnroll(joinCode);
      if (enrollment) {
        joinState = { tag: "enrolled", enrollment };
        return ok(joinState);
      }
      if (offer.claim?.joinConfirmed && offer.claim.addConfirmed) {
        joinState = { tag: "confirmed-waiting" };
        return ok(joinState);
      }
      if (offer.claim) {
        const sas = await net.computeSas(joinCode);
        if (sas) {
          joinState = { tag: "claimed", sas };
          return ok(joinState);
        }
      }
      if (Date.now() > offer.expiresAt) {
        joinState = { tag: "expired" };
        return ok(joinState);
      }
      joinState = { tag: "waiting" };
      return ok(joinState);
    },

    async pairJoinConfirm() {
      if (!joinCode) return err("no offer started");
      net.confirmJoin(joinCode);
      return ok(null);
    },

    async pairAddStart(code: string) {
      addCode = code.replace(/\s+/g, "");
      const claimed = net.claim(addCode, instanceId);
      if (!claimed.ok) {
        addState = {
          tag: "failed",
          message: claimed.error === "claimed"
            ? "someone already tried this code"
            : claimed.error === "expired"
            ? "this code has expired"
            : "code not recognized",
        };
        return ok(null); // pairAddStart itself succeeds; status reports failure (mirrors join side symmetry)
      }
      addState = { tag: "connecting" };
      return ok(null);
    },

    async pairAddStatus() {
      if (!addCode) return err("no pairing started");
      if (addState.tag === "failed") return ok(addState);
      const offer = net.getOffer(addCode);
      if (!offer?.claim) return ok(addState);
      if (offer.claim.aborted) {
        addState = { tag: "failed", message: "the other device cancelled" };
        return ok(addState);
      }
      if (offer.claim.enrolled) {
        addState = { tag: "enrolled" };
        return ok(addState);
      }
      if (offer.claim.addConfirmed) {
        addState = { tag: "waiting-peer" };
        return ok(addState);
      }
      const sas = await net.computeSas(addCode);
      addState = sas ? { tag: "sas-ready", sas } : { tag: "connecting" };
      return ok(addState);
    },

    async pairAddConfirm(deviceName: string) {
      if (!addCode) return err("no pairing started");
      net.confirmAdd(addCode, deviceName);
      net.tryEnroll(addCode);
      return ok(null);
    },

    async pairAbort() {
      if (joinCode) net.abort(joinCode);
      if (addCode) net.abort(addCode);
      joinCode = addCode = undefined;
      joinState = { tag: "waiting" };
      addState = { tag: "connecting" };
      return ok(null);
    },

    async userCreate(profile: UsProfile) {
      const gid = net.createGroup(instanceId, profile);
      return ok(gid);
    },

    async usProfileGet() {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      return ok(doc.profile);
    },

    async usProfileSet(profile: UsProfile) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      doc.profile = profile;
      broadcast(doc, instanceId, { tag: "profile-changed" });
      return ok(null);
    },

    async usMarksList() {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      return ok([...doc.marks.values()]);
    },

    async usMarkPut(mark: UsMark) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      const existed = doc.marks.has(mark.provenance);
      doc.marks.set(mark.provenance, { ...mark });
      broadcast(
        doc,
        instanceId,
        existed
          ? { tag: "mark-changed", provenance: mark.provenance }
          : { tag: "mark-added", provenance: mark.provenance },
      );
      repairMarks(doc, instanceId);
      return ok(null);
    },

    async usMarkForget(provenance: string) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      doc.marks.delete(provenance);
      return ok(null);
    },

    async usMarkConfirm(provenance: string) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      const mark = doc.marks.get(provenance);
      if (mark) mark.needsReconfirm = false;
      return ok(null);
    },

    async usContactsList() {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      return ok([...doc.contacts.entries()] as Array<[string, string]>);
    },

    async usContactPut(card: string, petname: string) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      doc.contacts.set(card, petname);
      return ok(null);
    },

    async usDevicesList() {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      return ok([...doc.devices.values()]);
    },

    async usDeviceRevoke(agentId: string) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      const dev = doc.devices.get(agentId);
      if (!dev) return err("no such device");
      dev.revoked = true;
      broadcast(doc, instanceId, { tag: "device-revoked", name: dev.name });
      return ok(null);
    },

    async usEvents() {
      const doc = net.groupFor(instanceId);
      if (!doc) return ok([]);
      ensureQueue(doc, instanceId);
      const q = doc.eventQueues.get(instanceId)!;
      const drained = q.splice(0, q.length);
      return ok(drained);
    },
  };

  return driver;
}
