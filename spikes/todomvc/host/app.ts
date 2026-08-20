// Shared wiring: artifact loading, backend construction, and the
// serialized guest-call runner used by every page.

import { artifactsFromEnvelope, instantiate } from "@deltic/runtime/embedder";
import { createSurface } from "../../../visor/surface/surface.ts";
import type { Backend, BackendKind } from "../../../visor/surface/backend.ts";
import { createDirectBackend } from "../../../visor/surface/backend-direct.ts";
import { createQueuedBackend } from "../../../visor/surface/backend-queued.ts";
import { createChannelBackend } from "../../../visor/surface/backend-channel.ts";
import { createFrameBackend } from "../../../visor/frame/frame-backend.ts";
import { createApplier } from "../../../visor/surface/applier.ts";
import type { UiEvent } from "../../../visor/surface/events.ts";
import { createRunner, type Runner } from "../../../visor/surface/runner.ts";

export { createRunner, type Runner };

// --- artifacts ---------------------------------------------------------------

const artifactCache = new Map<
  string,
  Promise<{ envelope: string; bytes: Uint8Array }>
>();

function loadArtifacts(name: string) {
  let p = artifactCache.get(name);
  if (!p) {
    p = Promise.all([
      fetch(`./${name}.plan.json`).then((r) => {
        if (!r.ok) throw new Error(`${name} plan fetch: HTTP ${r.status}`);
        return r.text();
      }),
      fetch(`./${name}.component.wasm`).then((r) => {
        if (!r.ok) throw new Error(`${name} component fetch: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    ]).then(([envelope, bytes]) => ({
      envelope,
      bytes: new Uint8Array(bytes),
    }));
    artifactCache.set(name, p);
  }
  return p;
}

export async function instantiateWorld(
  name: string,
  imports: Record<string, Record<string, unknown>>,
): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  const { envelope, bytes } = await loadArtifacts(name);
  const component = await instantiate(
    artifactsFromEnvelope(envelope, bytes),
    imports,
  );
  // deno-lint-ignore no-explicit-any
  return component.exports as any;
}

// --- backends ------------------------------------------------------------------

/** The three backends `createBackend` builds synchronously, in-realm.
 * "frame" is deliberately excluded from this type: its construction is
 * async (a handshake with the sandboxed frame's own document — see
 * createFrameBackend), so every caller branches on it separately rather
 * than folding it into this switch (see `resolveBackend` below). */
export type SameRealmBackendKind = Exclude<BackendKind, "frame">;

export function createBackend(
  kind: SameRealmBackendKind,
  container: HTMLElement,
  dispatch: (ev: UiEvent) => void,
): Backend {
  switch (kind) {
    case "direct":
      return createDirectBackend(container, dispatch);
    case "queued": {
      // Same-realm canary configuration: structuredClone enforces
      // serializability on every batch; the applier re-validates.
      const applier = createApplier(container, dispatch);
      return createQueuedBackend((ops) => applier.apply(structuredClone(ops)));
    }
    case "channel":
      return createChannelBackend(container, dispatch);
  }
}

/** The frame surface's teardown, handed back to the caller so `kind ===
 * "frame"` can be torn down on demand (see TodoApp.teardown). undefined
 * for the three same-realm kinds, whose kill semantics are unchanged:
 * the runner is simply paused forever and the DOM node is dropped by the
 * caller (see host/visor.ts's kill tenant, pre/post-C3). */
type Teardown = (() => Promise<void>) | undefined;

/** Resolve one backend for `kind`, awaiting the frame handshake when
 * `kind === "frame"` and constructing synchronously otherwise (a small
 * internal async step either way — `createBackend`'s own signature and
 * the three same-realm cases inside it are unchanged). */
async function resolveBackend(
  kind: BackendKind,
  container: HTMLElement,
  dispatch: (ev: UiEvent) => void,
): Promise<{ backend: Backend; teardown: Teardown }> {
  if (kind === "frame") {
    const frameBackend = createFrameBackend(container, dispatch);
    const backend = await frameBackend.backend;
    return { backend, teardown: () => frameBackend.destroy() };
  }
  return { backend: createBackend(kind, container, dispatch), teardown: undefined };
}

// --- the TodoMVC app ------------------------------------------------------------

export interface TodoExports {
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  onRoute(route: string): Promise<void>;
}

export interface TodoApp {
  runner: Runner;
  exports: TodoExports;
  /** Inject a synthetic event record (harness use). */
  sendEvent(ev: UiEvent): Promise<void>;
  sendRoute(route: string): Promise<void>;
  /** Destroy the sandboxed frame surface, when there is one — undefined
   * (no-op) for the three same-realm kinds, whose kill semantics stay
   * "pause the runner forever, drop the DOM node" (host/visor.ts's kill
   * tenant does the dropping; this is only the frame's own teardown). */
  teardown?(): Promise<void>;
}

export async function startTodoApp(
  kind: BackendKind,
  container: HTMLElement,
  route: () => string,
  onEventError: (e: unknown) => void,
  artifact = "todomvc",
): Promise<TodoApp> {
  // DOM-originated events land on the same serialized chain as everything
  // else; the exports binding below closes the loop.
  let dispatch: (ev: UiEvent) => void = () => {};
  const { backend, teardown } = await resolveBackend(kind, container, (ev) => dispatch(ev));
  const surface = createSurface(backend, route);
  const exports = (await instantiateWorld(
    artifact,
    surface.imports,
  )) as unknown as TodoExports;
  const runner = createRunner(surface);
  dispatch = (ev) => {
    runner.call(() => exports.onEvent(ev)).catch(onEventError);
  };
  await runner.call(() => exports.run());
  return {
    runner,
    exports,
    sendEvent: (ev) => runner.call(() => exports.onEvent(ev)),
    sendRoute: (r) => runner.call(() => exports.onRoute(r)),
    teardown,
  };
}

// --- the lab guest ----------------------------------------------------------------

export interface LabExports {
  probe(id: number): Promise<void>;
  bench(scenario: number, n: number): Promise<void>;
}

export interface LabApp {
  runner: Runner;
  exports: LabExports;
}

export async function startLab(
  kind: BackendKind,
  container: HTMLElement,
): Promise<LabApp> {
  const { backend } = await resolveBackend(kind, container, () => {});
  const surface = createSurface(backend, () => "");
  const exports = (await instantiateWorld(
    "lab",
    surface.imports,
  )) as unknown as LabExports;
  return { runner: createRunner(surface), exports };
}
