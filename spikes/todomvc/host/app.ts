// Shared wiring: artifact loading, backend construction, and the
// serialized guest-call runner used by every page.

import { artifactsFromEnvelope, instantiate } from "@deltic/runtime/embedder";
import { createSurface, type Surface } from "./surface.ts";
import type { Backend, BackendKind } from "./backend.ts";
import { createDirectBackend } from "./backend-direct.ts";
import { createQueuedBackend } from "./backend-queued.ts";
import { createChannelBackend } from "./backend-channel.ts";
import { createApplier } from "./applier.ts";
import type { UiEvent } from "./events.ts";

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

export function createBackend(
  kind: BackendKind,
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

// --- the serialized guest-call runner -------------------------------------------

export interface Runner {
  /** Queue one guest invocation; flushes at the end even if it traps. */
  call<T>(f: () => Promise<T>): Promise<T>;
  /** Settle the chain AND the backend (ops applied to the DOM). */
  settle(): Promise<void>;
  /** Monotonic count of queued invocations (quiescence detection). */
  readonly generation: number;
}

export function createRunner(surface: Surface): Runner {
  let chain: Promise<unknown> = Promise.resolve();
  let generation = 0;
  const call = <T>(f: () => Promise<T>): Promise<T> => {
    generation++;
    // Ops emitted before a trap are applied; the flush runs on both paths.
    const next = chain.then(f).then(
      (v) => {
        surface.flush();
        return v;
      },
      (e) => {
        surface.flush();
        throw e;
      },
    );
    // The chain itself must survive rejections so later calls still run.
    chain = next.catch(() => {});
    return next;
  };
  return {
    call,
    settle: async () => {
      await chain;
      await surface.drain();
    },
    get generation() {
      return generation;
    },
  };
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
}

export async function startTodoApp(
  kind: BackendKind,
  container: HTMLElement,
  route: () => string,
  onEventError: (e: unknown) => void,
): Promise<TodoApp> {
  // DOM-originated events land on the same serialized chain as everything
  // else; the exports binding below closes the loop.
  let dispatch: (ev: UiEvent) => void = () => {};
  const backend = createBackend(kind, container, (ev) => dispatch(ev));
  const surface = createSurface(backend, route);
  const exports = (await instantiateWorld(
    "todomvc",
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
  const backend = createBackend(kind, container, () => {});
  const surface = createSurface(backend, () => "");
  const exports = (await instantiateWorld(
    "lab",
    surface.imports,
  )) as unknown as LabExports;
  return { runner: createRunner(surface), exports };
}
