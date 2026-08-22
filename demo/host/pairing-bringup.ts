// Headless smoke of the real engine's pairing + user-system surface
// (Track A -> Track B integration), through THIS track's own adapter
// (../../runtime/pairing-engine.ts) rather than calling `driver.pair-*` directly —
// the point is to exercise the exact seam the visor UI will use.
//
//   deno run -A host/pairing-bringup.ts
//
// Needs `just infra` running (iroh relay :3340) — same rig as
// host/bringup.ts's `wire` phase. Two engine instances pair over the
// real iroh transport: the join side starts an offer, the add side
// claims the code, both sides observe the same SAS, both confirm, and
// ENROLL lands. Then one side sets its profile and the other drains the
// broadcast via `us-events`.
//
// Crypto-adjacent content-filter hygiene (per dispatch): SAS/ids are
// reported by LENGTH/prefix only, never printed in full.

import { type Engine, hex, newEngine, unhex, until } from "../../runtime/engine.ts";
import { createEnginePairingDriver } from "../../runtime/pairing-engine.ts";
import { probeNoNet } from "./probe-net.ts";
import type { PairAddState, PairJoinState } from "../../visor/ui/pairing-driver.ts";

const ENVELOPE = new URL("../build/engine.plan.json", import.meta.url);
const WASM = new URL("../../engine/target/composed.wasm", import.meta.url);
const RELAY = "http://127.0.0.1:3340";

async function loadArtifacts() {
  return {
    envelope: await Deno.readTextFile(ENVELOPE),
    bytes: await Deno.readFile(WASM),
  };
}

let stepT0 = performance.now();
function step(label: string) {
  const dt = (performance.now() - stepT0).toFixed(1);
  console.log(`[${dt.padStart(8)}ms] ${label}`);
  stepT0 = performance.now();
}

function dumpOnFail(engines: [string, Engine][]) {
  for (const [name, e] of engines) {
    const err = e.stderr();
    if (err.trim()) console.error(`--- ${name} stderr ---\n${err}`);
  }
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

async function main() {
  const artifacts = await loadArtifacts();
  // Both instances need `init` (identity) before pairing can bind an
  // iroh endpoint; pairing itself is exercised entirely through the
  // adapter, never the raw `driver.pair-*` calls.
  const join = await newEngine("join", artifacts, probeNoNet);
  const add = await newEngine("add", artifacts, probeNoNet);
  step("instantiated join + add");
  try {
    const joinId = unhex(await join.driver.init(false));
    const addId = unhex(await add.driver.init(false));
    step("init ×2");

    // Pairing rides the real iroh transport (guest/src/pairing.rs:433
    // "iroh-bind first" — an unbound instance's pair-join-start/
    // pair-add-start refuse), so both instances must bind to the relay
    // before either side of the ceremony can proceed.
    await join.driver.irohBind(RELAY);
    const addEp = unhex(await add.driver.irohBind(RELAY));
    step("iroh-bind ×2");

    const joinDriver = createEnginePairingDriver(join.driver);
    const addDriver = createEnginePairingDriver(add.driver);

    // First device: create the user group the joiner will enroll into.
    const userGroupId = unwrap(
      await addDriver.userCreate({ displayName: "Add Device", hue: 0 }),
    );
    step(`user-create: userGroupId len=${userGroupId.length} chars`);

    // --- the account's TASKS PARTITION, created BEFORE anyone pairs ---
    //
    // ORDER IS THE POINT. The founder makes a todo list the moment it
    // makes an account (demo/host/solo.ts's first-run path does exactly
    // this), so by the time a second device joins, that partition has
    // been created, delegated, sealed and WRITTEN TO — all under epochs
    // the joiner does not hold, because it did not exist yet.
    //
    // Reading it afterwards is therefore the PRE-JOIN case (PAIRING.md
    // §4b's causal walk), not the easy one. This used to be exercised
    // the other way round — the partition was created after the
    // ceremony, so every chunk was already under an epoch the joiner
    // held — and the difference was invisible here while being fatal in
    // a real two-page embedding: the joiner synced every chunk and
    // decrypted none of them, for ever. What closes it is the walk
    // anchor `enroll-device` now writes into each account partition
    // (engine/guest/src/usdoc.rs's `anchor_data_partitions`), and this
    // ordering is what gates it.
    const tasksPartition = await add.driver.createPartition();
    await add.driver.khAddMember(tasksPartition, unhex(userGroupId), "edit");
    await add.driver.sealPartition(tasksPartition);
    await add.driver.usPartitionPut("tasks", tasksPartition);
    await add.tasks.add("milk (written by the founder, before anyone paired)");
    step("tasks partition created, delegated to the user group, written to, pointer published");

    const offer = unwrap(await joinDriver.pairJoinStart());
    step(`pair-join-start: code len=${offer.code.length}, expiresMs=${offer.expiresMs}`);

    unwrap(await addDriver.pairAddStart(offer.code));
    step("pair-add-start: claimed");

    const joinSas = await until<string>("join SAS", async () => {
      const s = unwrap(await joinDriver.pairJoinStatus()) as PairJoinState;
      return s.tag === "claimed" ? s.sas : false;
    });
    const addSas = await until<string>("add SAS", async () => {
      const s = unwrap(await addDriver.pairAddStatus()) as PairAddState;
      return s.tag === "sas-ready" ? s.sas : false;
    });
    step(`SAS observed both sides: join len=${joinSas.length} add len=${addSas.length}`);
    if (joinSas !== addSas) {
      throw new Error(`SAS MISMATCH: join len=${joinSas.length} add len=${addSas.length}`);
    }
    if (!/^\d{6}$/.test(joinSas)) {
      throw new Error(`SAS not 6 digits (len=${joinSas.length})`);
    }
    console.log("  SAS equal on both sides (6-digit decimal, value redacted)");

    unwrap(await joinDriver.pairJoinConfirm());
    unwrap(await addDriver.pairAddConfirm("join's new device"));
    step("both confirmed");

    const enrollment = await until("join enrolled", async () => {
      const s = unwrap(await joinDriver.pairJoinStatus()) as PairJoinState;
      return s.tag === "enrolled" ? s.enrollment : false;
    });
    step(
      `enrolled: userGroupId len=${enrollment.userGroupId.length} partitionId len=${enrollment.partitionId.length}`,
    );
    if (enrollment.userGroupId !== userGroupId) {
      throw new Error("enrolled into the wrong user group");
    }

    // --- the enrollment's OBSERVED peer ids (engine.wit's
    // `pair-enrollment`) ---
    //
    // These two are what makes the cross-page solo embedding possible at
    // all: a joiner in its own browser page has no out-of-band channel
    // to learn which device just enrolled it, so without them it holds a
    // membership it can never sync. This harness DOES have both sides in
    // scope, which is exactly why the assertion belongs here — it is the
    // only place that can tell "the adder's real ids" from "some
    // plausible 32 bytes".
    //
    // Read from the RAW driver, not the adapter: the visor's
    // `PairingDriver` contract carries the two-field shape on purpose
    // (runtime/pairing-engine.ts's `toMockJoinState`), because dialling
    // is the embedder's act.
    const raw = await join.driver.pairJoinStatus();
    if (raw.kind !== "enrolled") {
      throw new Error(`raw join status is ${raw.kind}, expected enrolled`);
    }
    const observed = raw.value;
    if (hex(observed.peerAgentId) !== hex(addId)) {
      throw new Error(
        `pair-enrollment.peer-agent-id is not the add side's agent id ` +
          `(got ${observed.peerAgentId.length} bytes)`,
      );
    }
    if (hex(observed.peerEndpointId) !== hex(addEp)) {
      throw new Error(
        `pair-enrollment.peer-endpoint-id is not the add side's endpoint id ` +
          `(got ${observed.peerEndpointId.length} bytes)`,
      );
    }
    step(
      `enrollment carries the ADD side's observed ids: agent len=${observed.peerAgentId.length}, ` +
        `endpoint len=${observed.peerEndpointId.length} (values redacted)`,
    );

    await until("add side sees enrolled", async () => {
      const s = unwrap(await addDriver.pairAddStatus()) as PairAddState;
      return s.tag === "enrolled" || false;
    });
    step("add side confirms enrolled");

    // Pairing grants membership; it does not by itself wire subduction
    // between the two devices. PAIRING.md §2 step 7 ends the ceremony
    // with "sync", and the engine leaves that to the embedder: the
    // native act battery does exactly this (engine/host/src/
    // pairing_acts.rs:187 `wire_us` — connect, then sync-start with
    // `subscribe` both ways), so the headless smoke does too. Without
    // it the joiner has a membership and an empty doc, and nothing the
    // adder writes can reach it.
    //
    // DIALLED FROM THE ENROLLMENT'S OWN FIELDS, not from the `addEp`/
    // `addId` this harness happens to hold. Both are asserted equal
    // above, so the two are interchangeable HERE — and that is precisely
    // why using the enrollment is worth doing: it makes this the same
    // code path a real embedder with no other channel has to walk
    // (demo/host/solo.ts), so a regression in those fields breaks the
    // sync here instead of only in a browser.
    const ca = await add.driver.irohStart(false, new Uint8Array(), RELAY, new Uint8Array());
    const cb = await join.driver.irohStart(
      true,
      observed.peerEndpointId,
      RELAY,
      observed.peerAgentId,
    );
    await until(
      "subduction handshake",
      async () => (await join.driver.connStatus(cb)) && (await add.driver.connStatus(ca)),
    );
    const partition = unhex(enrollment.partitionId);
    for (const [who, e, peer] of [
      ["join", join, addId] as const,
      ["add", add, joinId] as const,
    ]) {
      const h = await e.driver.syncStart(peer, partition, true);
      await until(`${who} subscribes to the user-system doc`, () => e.driver.syncStatus(h));
    }
    step("subduction wired + both sides subscribed");

    // us-profile-set on one side + us-events drain on the other.
    unwrap(await addDriver.usProfileSet({ displayName: "Renamed", hue: 3 }));
    step("us-profile-set on add side");

    const events = await until("join drains profile-changed", async () => {
      const evs = unwrap(await joinDriver.usEvents());
      return evs.length > 0 ? evs : false;
    });
    step(`join drained ${events.length} event(s): ${events.map((e) => e.tag).join(", ")}`);
    if (!events.some((e) => e.tag === "profile-changed")) {
      throw new Error("expected a profile-changed event on the join side");
    }

    // --- the partition-pointer map (#36) ---
    //
    // Beat 1: the founder publishes the account's tasks partition into
    // the user-system doc, and the joined device DISCOVERS it — a paired
    // device has no other way to learn the id.
    //
    // Beat 2: the partition is delegated to the USER GROUP (never to the
    // joiner's individual), so the joiner's read is the transitive
    // membership pairing already gave it. That is the property the solo
    // page rests on, so the smoke gates it and not just the native acts.
    const discovered = await until("join discovers the tasks partition", async () => {
      const list = await join.driver.usPartitions();
      return list.find((x) => x.name === "tasks") ?? false;
    });
    if (hex(discovered.id) !== hex(tasksPartition)) {
      throw new Error("the joined device read a different partition id than was published");
    }
    step(`us-partitions round trip: name=${discovered.name} id len=${discovered.id.length}`);

    await join.driver.adoptPartition(discovered.id);
    for (const [who, e, peer] of [
      ["join", join, addId] as const,
      ["add", add, joinId] as const,
    ]) {
      const h = await e.driver.syncStart(peer, discovered.id, true);
      await until(`${who} subscribes to the tasks partition`, () => e.driver.syncStatus(h));
    }
    // THE PRE-JOIN READ. This content was written before the joiner
    // existed; reaching it is the causal walk working from the anchor
    // enrollment left in this partition.
    await until("join reads the PRE-JOIN content of the group-delegated partition", async () => {
      try {
        const snap = await join.tasks.items();
        return snap.items.some((i) =>
          i.title === "milk (written by the founder, before anyone paired)"
        );
      } catch {
        // Epoch material still in flight — not ready, not a failure.
        return false;
      }
    });
    step("joined device READS pre-join content of the group-delegated tasks partition");

    // And the ordinary case still works: a write made AFTER the join
    // lands too, so the anchor did not somehow freeze the partition at
    // the enrollment boundary.
    await add.tasks.add("bread (written after the join)");
    await until("join reads a post-join write", async () => {
      try {
        const snap = await join.tasks.items();
        return snap.items.some((i) => i.title === "bread (written after the join)");
      } catch {
        return false;
      }
    });
    step("joined device READS a post-join write on the same partition");

    console.log("\nPAIRING BRINGUP PASS");
  } catch (e) {
    dumpOnFail([["join", join], ["add", add]]);
    throw e;
  }
}

await main();
Deno.exit(0);
