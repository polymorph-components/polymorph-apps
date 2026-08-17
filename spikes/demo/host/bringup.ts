// Deno bring-up of the engine composite under deltic — retire the
// platform risks (translation, CM-async task wakeups, wasi p2+p3 track
// serving, webcrypto port coverage, iroh-over-websocket, wasi:http
// against MinIO) before any browser work.
//
//   deno run -A host/bringup.ts solo          # one instance, no wire
//   deno run -A host/bringup.ts wire          # two instances over the relay
//   deno run -A host/bringup.ts bucket        # MinIO flush + cold pull
//
// Infra (relay, MinIO) is started by the justfile.

import { type Engine, hex, newEngine, unhex, until } from "./engine.ts";

const RELAY = "http://127.0.0.1:3340";
const S3 = {
  endpoint: "http://127.0.0.1:9000",
  bucket: "pm-demo",
  access: "minioadmin",
  secret: "minioadmin",
};

const ENVELOPE = new URL("../build/engine.plan.json", import.meta.url);
const WASM = new URL(
  "../../tasks-engine/target/composed.wasm",
  import.meta.url,
);

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

// --- phase: solo -------------------------------------------------------------

async function solo() {
  const artifacts = await loadArtifacts();
  const t0 = performance.now();
  const a = await newEngine("solo", artifacts);
  step(`instantiated (${(performance.now() - t0).toFixed(0)}ms total)`);
  try {
    const id = await a.driver.init(false);
    step(`init: ${id.slice(0, 16)}…`);
    const part = await a.driver.createPartition();
    step(`create-partition: ${hex(part).slice(0, 16)}…`);
    await a.driver.sealPartition(part);
    step("seal-partition");
    const milk = await a.tasks.add("buy milk");
    await a.tasks.add("write demo");
    step(`tasks.add ×2 (milk id ${milk})`);
    await a.tasks.setCompleted(milk, true);
    const snap = await a.tasks.items();
    step(`items: rev=${snap.revision} ${JSON.stringify(snap.items)}`);
    if (snap.items.length !== 2) throw new Error("expected 2 items");
    if (!snap.items.some((i) => i.title === "buy milk" && i.completed)) {
      throw new Error("toggle lost");
    }
    const [chunks, maxParents] = await a.driver.chunkStats(part);
    step(`chunk-stats: chunks=${chunks} max-parents=${maxParents}`);
    console.log("\nSOLO PASS");
  } catch (e) {
    dumpOnFail([["solo", a]]);
    throw e;
  }
}

// --- phase: wire -------------------------------------------------------------

async function wire() {
  const artifacts = await loadArtifacts();
  const alice = await newEngine("alice", artifacts);
  const bob = await newEngine("bob", artifacts);
  step("instantiated alice + bob");
  try {
    const aliceId = unhex(await alice.driver.init(false));
    const bobId = unhex(await bob.driver.init(false));
    step("init ×2");

    await alice.driver.irohBind(RELAY);
    const bobEp = unhex(await bob.driver.irohBind(RELAY));
    step("iroh-bind ×2");

    const cb = await bob.driver.irohStart(false, new Uint8Array(), RELAY, new Uint8Array());
    const ca = await alice.driver.irohStart(true, bobEp, RELAY, bobId);
    await until("handshake", async () =>
      (await alice.driver.connStatus(ca)) && (await bob.driver.connStatus(cb)));
    step("subduction handshake over iroh websocket relay");

    await until("contact cards", async () =>
      (await alice.driver.khKnowsAgent(bobId)) &&
      (await bob.driver.khKnowsAgent(aliceId)));
    step("contact cards over the bridge");

    const part = await alice.driver.createPartition();
    await alice.driver.khAddMember(part, bobId, "edit");
    await alice.driver.sealPartition(part);
    await bob.driver.adoptPartition(part);
    step("partition: create → member(edit) → seal → adopt");

    // Deltic divergence probe (recorded): a subscribe=true FIRST sync
    // reports commits received but does not store them; a plain pull
    // stores fine. Order: pull first, then subscribe.
    const pull = async (who: string, e: typeof bob, from: Uint8Array) => {
      const h = await e.driver.syncStart(from, part, false);
      return await until(`${who} pull`, () => e.driver.syncStatus(h));
    };
    await until("bob's keyhive knows the doc (bridge)", () => bob.driver.khKnowsAgent(part));
    console.log("  bob pull:", await pull("bob", bob, aliceId));
    await until("bob decrypts creation", async () =>
      (await bob.tasks.revision()) >= 1n);
    const hs = await bob.driver.syncStart(aliceId, part, true);
    console.log("  bob subscribe:", await until("bob subscribe", () => bob.driver.syncStatus(hs)));
    console.log("  alice pull:", await pull("alice", alice, bobId));
    const ha = await alice.driver.syncStart(bobId, part, true);
    console.log("  alice subscribe:", await until("alice subscribe", () => alice.driver.syncStatus(ha)));
    step("pulls + subscriptions up");

    await alice.tasks.add("from alice");
    await until("bob sees alice's task", async () =>
      (await bob.tasks.items()).items.some((i) => i.title === "from alice"));
    step("alice → bob over the wire");

    await bob.tasks.add("from bob");
    await until("alice sees bob's task", async () =>
      (await alice.tasks.items()).items.some((i) => i.title === "from bob"));
    step("bob → alice over the wire (transitive put authority)");

    // Soak: revoke bob, keep every background loop running for 30s —
    // the browser wedge suspect (post-revocation refused pulls + nudged
    // keyhive re-syncs) reproduces here if it is engine-side.
    if (Deno.args[1] === "soak") {
      await alice.driver.khRevokeMember(part, bobId);
      await alice.tasks.add("secret");
      const t0 = performance.now();
      let cycles = 0;
      while (performance.now() - t0 < 30_000) {
        await alice.tasks.items();
        await bob.tasks.items().catch(() => {});
        const h = await bob.driver.syncStart(aliceId, part, false);
        await until("refused pull settles", () => bob.driver.syncStatus(h)).catch(() => {});
        await pull("alice", alice, bobId).catch(() => {});
        cycles++;
        await new Promise((r) => setTimeout(r, 250));
      }
      console.log(`soak: ${cycles} cycles, no wedge; bob items:`,
        (await bob.tasks.items()).items.length);
    }

    console.log("\nWIRE PASS");
  } catch (e) {
    dumpOnFail([["alice", alice], ["bob", bob]]);
    throw e;
  }
}

// --- phase: bucket -----------------------------------------------------------

async function bucket() {
  const artifacts = await loadArtifacts();
  const owner = await newEngine("owner", artifacts);
  const cold = await newEngine("cold", artifacts);
  step("instantiated owner + cold");
  try {
    const ownerId = unhex(await owner.driver.init(false));
    const coldId = unhex(await cold.driver.init(false));
    step("init ×2");

    // Enrollment cards are host-carried (the cold device has no wire).
    await owner.driver.khIngestContact(await cold.driver.khContactCard());
    await cold.driver.khIngestContact(await owner.driver.khContactCard());
    step("contact cards pasted both ways");

    const part = await owner.driver.createPartition();
    await owner.driver.khAddMember(part, coldId, "edit");
    await owner.driver.sealPartition(part);
    step("partition sealed with cold member");

    await owner.driver.initStore(S3.endpoint, S3.bucket, S3.access, S3.secret);
    await owner.driver.ensureBucket();
    await owner.driver.storeGrant(part, ownerId);
    await owner.driver.storeGrant(part, coldId);
    step("store configured + K_p granted");

    await owner.tasks.add("bucketed task");
    await owner.tasks.add("second task");
    console.log("  flush:", await owner.driver.bucketFlush(part));
    step("authored + flushed");

    await cold.driver.initStore(S3.endpoint, S3.bucket, "", "");
    await cold.driver.adoptPartition(part);
    console.log("  pull:", await cold.driver.bucketPull(part, ownerId));
    const snap = await cold.tasks.items();
    step(`cold pull: rev=${snap.revision} items=${snap.items.length}`);
    if (snap.items.length !== 2) throw new Error("cold boot incomplete");

    console.log("\nBUCKET PASS");
  } catch (e) {
    dumpOnFail([["owner", owner], ["cold", cold]]);
    throw e;
  }
}

// --- main ---------------------------------------------------------------------

const phase = Deno.args[0] ?? "solo";
const phases: Record<string, () => Promise<void>> = { solo, wire, bucket };
const run = phases[phase];
if (!run) {
  console.error(`unknown phase ${phase}; expected: ${Object.keys(phases).join("|")}`);
  Deno.exit(2);
}
await run();
Deno.exit(0);
