// The channel backend: the queued protocol carried over a real
// MessageChannel — a faithful stand-in for the worker/frame split.
// postMessage performs the structured clone; ops flow one way, event
// records flow back, and drain() round-trips a marker so callers can
// await application (needed for fair benchmarks and for harness
// snapshots; the app itself never needs it).

import type { Backend } from "./backend.ts";
import { createQueuedBackend, type Op } from "./backend-queued.ts";
import { createApplier } from "./applier.ts";
import type { UiEvent } from "./events.ts";

type ShellMsg =
  | { t: "ops"; ops: Op[] }
  | { t: "drain"; id: number };
type FrameMsg =
  | { t: "event"; ev: UiEvent }
  | { t: "drained"; id: number };

export function createChannelBackend(
  container: HTMLElement,
  dispatch: (ev: UiEvent) => void,
): Backend {
  const { port1, port2 } = new MessageChannel();

  // --- frame side (would live in the sandboxed UI frame) ---
  const applier = createApplier(
    container,
    (ev) => port2.postMessage({ t: "event", ev } satisfies FrameMsg),
  );
  port2.onmessage = (m: MessageEvent<ShellMsg>) => {
    if (m.data.t === "ops") applier.apply(m.data.ops);
    else if (m.data.t === "drain") {
      port2.postMessage({ t: "drained", id: m.data.id } satisfies FrameMsg);
    }
  };

  // --- shell side ---
  const pendingDrains = new Map<number, () => void>();
  let drainId = 0;
  port1.onmessage = (m: MessageEvent<FrameMsg>) => {
    if (m.data.t === "event") dispatch(m.data.ev);
    else if (m.data.t === "drained") {
      pendingDrains.get(m.data.id)?.();
      pendingDrains.delete(m.data.id);
    }
  };

  const queued = createQueuedBackend(
    (ops) => port1.postMessage({ t: "ops", ops } satisfies ShellMsg),
  );

  return {
    ...queued,
    drain: () =>
      new Promise<void>((resolve) => {
        const id = drainId++;
        pendingDrains.set(id, resolve);
        port1.postMessage({ t: "drain", id } satisfies ShellMsg);
      }),
  };
}
