// A backend implements the surface's ordering spec (see wit/todomvc.wit,
// world `lab` doc comment) for one placement. The surface front-end owns
// ALL guest-facing validation and calls these primitives with
// already-checked arguments; `Rep` is the backend's element representation
// (an integer id for op-queue backends, the real Element for the direct
// backend).
//
// Semantics every backend must preserve identically: call-order
// application, flush at end of guest invocation (a trapped invocation
// still flushes what it emitted), listener records built by
// events.attachListener, free() releases bookkeeping never DOM nodes.

export type Rep = unknown;

export interface Backend {
  readonly root: Rep;
  create(tag: string): Rep;
  textNode(data: string): Rep;
  attr(rep: Rep, name: string, value: string | null): void;
  append(parent: Rep, child: Rep): void;
  before(ref: Rep, node: Rep): void;
  after(ref: Rep, node: Rep): void;
  remove(rep: Rep): void;
  text(rep: Rep, text: string): void;
  value(rep: Rep, value: string): void;
  checked(rep: Rep, checked: boolean): void;
  focus(rep: Rep): void;
  listen(rep: Rep, kind: string, token: number): void;
  free(rep: Rep): void;
  /** End-of-invocation flush boundary. No-op for immediate backends. */
  flush(): void;
  /** Resolve once all flushed ops have been applied to the DOM. */
  drain(): Promise<void>;
}

// "frame": the queued protocol carried to a real sandboxed iframe on an
// opaque origin (visor/frame/frame-backend.ts) rather than constructed
// in-realm by `createBackend` below — its construction is async (a
// handshake with the frame's own document) where the other three are
// synchronous, so it is a distinct code path in every consumer, not a
// fourth case in the same switch.
export type BackendKind = "queued" | "direct" | "channel" | "frame";

export function isBackendKind(s: string | null): s is BackendKind {
  return s === "queued" || s === "direct" || s === "channel" || s === "frame";
}
