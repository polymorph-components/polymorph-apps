// Boot: fetch the component + its translation envelope, wire the surface
// to the applier (the seam), instantiate under deltic, and pump events.
//
// Guest invocations are serialized on one promise chain: each event runs
// the export, then flushes the op batch to the applier — one batch per
// guest call ("chunky protocol", polymorph-apps#15/#16).

import "./polyfill.ts";
import { artifactsFromEnvelope, instantiate } from "@deltic/runtime/embedder";
import { createSurface } from "./surface.ts";
import { createApplier, type UiEvent } from "./applier.ts";

interface Exports {
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  onRoute(route: string): Promise<void>;
}

const container = document.getElementById("app") as HTMLElement;

function showError(e: unknown): void {
  console.error(e);
  const pre = document.createElement("pre");
  pre.style.cssText =
    "color:#b83f45;white-space:pre-wrap;padding:16px;font-size:12px";
  pre.textContent = `spike failed:\n${
    e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)
  }`;
  container.replaceChildren(pre);
}

function status(msg: string): void {
  container.textContent = msg;
}

const route = () => location.hash.replace(/^#\/?/, "");

try {
  status("loading component…");
  const [envelope, bytes] = await Promise.all([
    fetch("./todomvc.plan.json").then((r) => {
      if (!r.ok) throw new Error(`plan fetch: HTTP ${r.status}`);
      return r.text();
    }),
    fetch("./todomvc.component.wasm").then((r) => {
      if (!r.ok) throw new Error(`component fetch: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);

  // Event dispatch lands on the serialized call chain (assigned below,
  // after instantiation; nothing can fire earlier — listeners only exist
  // once ops have been applied, which only happens on the chain).
  let enqueueEvent: (ev: UiEvent) => void = () => {};

  // The seam: ops cross as structured-cloneable data, enforced every batch.
  const applier = createApplier(container, (ev) => enqueueEvent(ev));
  const surface = createSurface(
    (ops) => applier.apply(structuredClone(ops)),
    route,
  );

  status("instantiating…");
  const component = await instantiate(
    artifactsFromEnvelope(envelope, new Uint8Array(bytes)),
    surface.imports,
  );
  const exports = component.exports as unknown as Exports;

  let chain = Promise.resolve();
  const call = (f: () => Promise<void>) => {
    chain = chain
      .then(f)
      .then(() => surface.flush())
      .catch(showError);
  };

  enqueueEvent = (ev) => call(() => exports.onEvent(ev));
  addEventListener("hashchange", () => call(() => exports.onRoute(route())));

  status("");
  call(() => exports.run());
} catch (e) {
  showError(e);
}
