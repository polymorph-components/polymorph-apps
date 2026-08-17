// Headless diagnosis, envelope path (no version-mixing): instantiate the
// preact guest under Deno, drive run/on-event, dump ops or the failure.
// Usage: deno run --allow-read tools/diag-preact.ts <component.wasm> <plan.json> [wasi]
import { artifactsFromEnvelope, instantiate } from "@deltic/runtime/embedder";
import { createSurface } from "../host/surface.ts";
import { createQueuedBackend, type Op } from "../host/backend-queued.ts";

const componentBytes = await Deno.readFile(Deno.args[0]);
const envelope = await Deno.readTextFile(Deno.args[1]);

const ops: Op[] = [];
const backend = createQueuedBackend((batch) => ops.push(...batch));
const surface = createSurface(backend, () => "");

let extra: Record<string, unknown> = {};
let captured: unknown = null;
if (Deno.args[2] === "wasi") {
  const { wasi } = await import("../../../vendor-deltic-wasi/mod.ts");
  const w = wasi();
  captured = w.captured;
  extra = w;
}

try {
  const component = await instantiate(
    artifactsFromEnvelope(envelope, componentBytes),
    { ...extra, ...surface.imports },
  );
  console.log("instantiated ok");
  const exports = component.exports as {
    run(): Promise<void>;
    onEvent(ev: unknown): Promise<void>;
  };
  await exports.run();
  surface.flush();
  console.log(`run ok: ${ops.length} ops; first 12:`);
  console.log(JSON.stringify(ops.slice(0, 12)));
  await exports.onEvent({
    token: 1,
    kind: "keydown",
    key: "Enter",
    value: "hello from deno",
    checked: undefined,
  });
  surface.flush();
  console.log(`after event: ${ops.length} ops total; last 12:`);
  console.log(JSON.stringify(ops.slice(-12)));
} catch (e) {
  console.log("FAILED:", e);
} finally {
  surface.flush();
  console.log(`--- ${ops.length} ops seen; tail:`);
  for (const op of ops.slice(-8)) console.log(JSON.stringify(op).slice(0, 600));
  if (captured) {
    console.log("--- captured:", JSON.stringify(captured).slice(0, 2000));
  }
}
