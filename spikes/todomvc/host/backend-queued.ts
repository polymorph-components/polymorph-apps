// The queued backend: serializable op batches (the seam). Reps are
// integer ids allocated here, so every op is fire-and-forget; flush hands
// one batch per guest invocation to the sink. With a same-realm sink this
// is the debug/canary configuration (structuredClone + applier
// re-validation); the channel backend reuses it across a real
// MessageChannel hop.

import type { Backend, Rep } from "./backend.ts";

export type Op =
  | ["create", number, string]
  | ["textnode", number, string]
  | ["attr", number, string, string | null]
  | ["append", number, number]
  | ["before", number, number]
  | ["after", number, number]
  | ["remove", number]
  | ["text", number, string]
  | ["value", number, string]
  | ["checked", number, boolean]
  | ["focus", number]
  | ["listen", number, string, number]
  | ["free", number];

export const ROOT_ID = 0;

export function createQueuedBackend(sink: (ops: Op[]) => void): Backend {
  let nextId = 1;
  let queue: Op[] = [];
  const push = (op: Op) => {
    queue.push(op);
  };
  const id = (rep: Rep) => rep as number;

  return {
    root: ROOT_ID,
    create: (tag) => {
      const rep = nextId++;
      push(["create", rep, tag]);
      return rep;
    },
    textNode: (data) => {
      const rep = nextId++;
      push(["textnode", rep, data]);
      return rep;
    },
    attr: (rep, name, value) => push(["attr", id(rep), name, value]),
    append: (parent, child) => push(["append", id(parent), id(child)]),
    before: (ref, node) => push(["before", id(ref), id(node)]),
    after: (ref, node) => push(["after", id(ref), id(node)]),
    remove: (rep) => push(["remove", id(rep)]),
    text: (rep, text) => push(["text", id(rep), text]),
    value: (rep, value) => push(["value", id(rep), value]),
    checked: (rep, checked) => push(["checked", id(rep), checked]),
    focus: (rep) => push(["focus", id(rep)]),
    listen: (rep, kind, token) => push(["listen", id(rep), kind, token]),
    free: (rep) => push(["free", id(rep)]),
    flush: () => {
      if (queue.length === 0) return;
      const ops = queue;
      queue = [];
      sink(ops);
    },
    drain: () => Promise.resolve(),
  };
}
