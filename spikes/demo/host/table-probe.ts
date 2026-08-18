// Which guest table grows under a pull loop? Prints the engine's own
// table sizes alongside process RSS.
import { type Engine, newEngine, unhex, until } from "./engine.ts";
const RELAY = "http://127.0.0.1:3340";
const artifacts = {
  envelope: await Deno.readTextFile(new URL("../build/engine.plan.json", import.meta.url)),
  bytes: await Deno.readFile(new URL("../../tasks-engine/target/composed.wasm", import.meta.url)),
};
const alice: Engine = await newEngine("alice", artifacts);
const bob: Engine = await newEngine("bob", artifacts);
const aliceId = unhex(await alice.driver.init(false));
const bobId = unhex(await bob.driver.init(false));
await alice.driver.irohBind(RELAY);
const bobEp = unhex(await bob.driver.irohBind(RELAY));
const cb = await bob.driver.irohStart(false, new Uint8Array(), RELAY, new Uint8Array());
const ca = await alice.driver.irohStart(true, bobEp, RELAY, bobId);
await until("handshake", async () => (await alice.driver.connStatus(ca)) && (await bob.driver.connStatus(cb)));
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
await alice.tasks.add("seed");
let n = 0;
for (let round = 0; round < 10; round++) {
  for (let i = 0; i < 20; i++) { await pull(bob, aliceId); await pull(alice, bobId); n += 2; }
  const rss = (Deno.memoryUsage().rss / 1048576).toFixed(0);
  console.log(`pulls=${String(n).padStart(4)} rss=${rss}MB | bob: ${await bob.driver.stats()}`);
}
