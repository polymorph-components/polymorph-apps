// --- the serialized guest-call runner -------------------------------------------

import type { Surface } from "./surface.ts";

export interface Runner {
  /** Queue one guest invocation; flushes at the end even if it traps. */
  call<T>(f: () => Promise<T>): Promise<T>;
  /** Settle the chain AND the backend (ops applied to the DOM). */
  settle(): Promise<void>;
  /** Monotonic count of queued invocations (quiescence detection). */
  readonly generation: number;
  /** Suspend guest invocations (modal visor, #22): queued, not delivered. */
  pause(): void;
  /** Resume delivery of queued invocations. */
  resume(): void;
}

export function createRunner(surface: Surface): Runner {
  let chain: Promise<unknown> = Promise.resolve();
  let generation = 0;
  let gate: Promise<void> = Promise.resolve();
  let releaseGate: (() => void) | null = null;
  const call = <T>(f: () => Promise<T>): Promise<T> => {
    generation++;
    // Ops emitted before a trap are applied; the flush runs on both paths.
    // The gate (visor-owned input suspension) is crossed before the guest
    // sees the invocation.
    const next = chain.then(() => gate).then(f).then(
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
    pause() {
      if (!releaseGate) {
        gate = new Promise((r) => {
          releaseGate = r;
        });
      }
    },
    resume() {
      releaseGate?.();
      releaseGate = null;
      gate = Promise.resolve();
    },
  };
}
