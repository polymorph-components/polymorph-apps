// Idle-leak probe: two engines over the relay with live subscriptions,
// then DO NOTHING for two minutes while sampling memory. The browser run
// grows ~2.4 MB/s with all page timers cleared; this asks whether that
// belongs to the engine/guest stack (reproduces here) or to the browser
// port layer (does not).
//
//   deno run -A host/leak-probe.ts [idleSeconds]

import { type Engine, newEngine, unhex, until } from "../../runtime/engine.ts";
import { probeNoNet } from "./probe-net.ts";

const RELAY = "http://127.0.0.1:3340";
const IDLE_S = Number(Deno.args[0] ?? 120);

const artifacts = {
  envelope: await Deno.readTextFile(new URL("../build/engine.plan.json", import.meta.url)),
  bytes: await Deno.readFile(new URL("../../engine/target/composed.wasm", import.meta.url)),
};

const sample = (tag: string) => {
  const m = Deno.memoryUsage();
  console.log(
    `${tag.padEnd(16)} rss=${(m.rss / 1048576).toFixed(1)}MB ` +
      `heap=${(m.heapUsed / 1048576).toFixed(1)}MB ` +
      `ext=${(m.external / 1048576).toFixed(1)}MB`,
  );
  return m;
};

const alice: Engine = await newEngine("alice", artifacts, probeNoNet);
const bob: Engine = await newEngine("bob", artifacts, probeNoNet);
const aliceId = unhex(await alice.driver.init(false));
const bobId = unhex(await bob.driver.init(false));

await alice.driver.irohBind(RELAY);
const bobEp = unhex(await bob.driver.irohBind(RELAY));
const cb = await bob.driver.irohStart(false, new Uint8Array(), RELAY, new Uint8Array());
const ca = await alice.driver.irohStart(true, bobEp, RELAY, bobId);
await until("handshake", async () =>
  (await alice.driver.connStatus(ca)) && (await bob.driver.connStatus(cb)));
await until("cards", () => alice.driver.khKnowsAgent(bobId));

const part = await alice.driver.createPartition();
await alice.driver.khAddMember(part, bobId, "edit");
await alice.driver.sealPartition(part);
await bob.driver.adoptPartition(part);
await until("bob knows doc", () => bob.driver.khKnowsAgent(part));

const pull = async (e: Engine, from: Uint8Array) => {
  const h = await e.driver.syncStart(from, part, false);
  return await until("pull", () => e.driver.syncStatus(h));
};
await pull(bob, aliceId);
// The subscriptions the browser demo holds open — the suspected source.
const hs = await bob.driver.syncStart(aliceId, part, true);
await until("bob subscribe", () => bob.driver.syncStatus(hs));
await pull(alice, bobId);
const ha = await alice.driver.syncStart(bobId, part, true);
await until("alice subscribe", () => alice.driver.syncStatus(ha));

await alice.tasks.add("one task, then silence");

// Mode: "idle" holds subscriptions open and does nothing; "pulls" runs the
// demo's reconciliation loop (a pull pair every 2.5 s), which is what the
// browser does and what the first version of this probe failed to model.
const MODE = Deno.args[1] ?? "idle";
if (MODE === "pulls") {
  setInterval(async () => {
    try {
      await pull(bob, aliceId);
      await pull(alice, bobId);
    } catch { /* ignore */ }
  }, 2500);
}

console.log(`\nsubscriptions live; ${MODE} for ${IDLE_S}s\n`);
const first = sample("idle t=0");
for (let t = 10; t <= IDLE_S; t += 10) {
  await new Promise((r) => setTimeout(r, 10_000));
  sample(`idle t=${t}`);
}
const last = sample("idle end");
const dRss = (last.rss - first.rss) / 1048576;
console.log(
  `\nRSS delta over ${IDLE_S}s idle: ${dRss.toFixed(1)}MB ` +
    `(${(dRss / IDLE_S * 1000).toFixed(0)} KB/s)`,
);
