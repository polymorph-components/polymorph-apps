// Build-time translation: component.wasm -> envelope (plan + FACT adapters).
// Uses the packaged translator so nothing needs building from the polyengine repo.
// Usage: deno run --allow-read --allow-write translate.ts in.wasm out.plan.json
import { defaultTranslator } from "@polyengine/translator";

const [input, output] = Deno.args;
if (!input || !output) {
  console.error("usage: translate.ts <component.wasm> <out.plan.json>");
  Deno.exit(2);
}

const translator = await defaultTranslator();
const t0 = performance.now();
const envelope = translator.translateRaw(await Deno.readFile(input));
const ms = (performance.now() - t0).toFixed(1);
await Deno.writeTextFile(output, envelope);
console.log(`${output}: ${envelope.length} bytes in ${ms}ms`);
