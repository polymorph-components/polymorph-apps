// The guest-facing half of the curated DOM surface: implements the WIT
// imports (`dom`, `events`, `shell`) as a resource class plus free
// functions, validates every call, and emits plain serializable ops.
//
// THE SEAM (polymorph-apps#16): nothing here touches the real DOM. Ops are
// JSON-able arrays consumed by the applier — today via a direct function
// call, later across postMessage when the applier moves into the sandboxed
// UI frame. Handles are allocated on THIS side, so every mutation is
// fire-and-forget: no synchronous read-backs to block on across the hop.

import { checkAttr, checkAttrName, checkEventKind, checkTag } from "./validate.ts";

export type Op =
  | ["create", number, string]
  | ["attr", number, string, string | null]
  | ["append", number, number]
  | ["remove", number]
  | ["text", number, string]
  | ["value", number, string]
  | ["checked", number, boolean]
  | ["focus", number]
  | ["listen", number, string, number]
  | ["free", number];

const ROOT_ID = 0;

export interface Surface {
  /** The imports record for `instantiate` (keys are verbatim WIT ids). */
  imports: Record<string, Record<string, unknown>>;
  /** Deliver queued ops to the sink. Called after every guest invocation. */
  flush(): void;
}

export function createSurface(
  sink: (ops: Op[]) => void,
  route: () => string,
): Surface {
  let nextId = 1;
  let queue: Op[] = [];

  const push = (op: Op) => {
    queue.push(op);
  };

  class SurfaceElement {
    readonly id: number;
    readonly tag: string;

    constructor(tag: string) {
      checkTag(tag);
      this.id = nextId++;
      this.tag = tag;
      push(["create", this.id, tag]);
    }

    setAttribute(name: string, value: string): void {
      checkAttr(this.tag, name, value);
      push(["attr", this.id, name, value]);
    }

    removeAttribute(name: string): void {
      checkAttrName(this.tag, name);
      push(["attr", this.id, name, null]);
    }

    appendChild(child: SurfaceElement): void {
      push(["append", this.id, child.id]);
    }

    remove(): void {
      push(["remove", this.id]);
    }

    setTextContent(text: string): void {
      push(["text", this.id, text]);
    }

    setValue(value: string): void {
      requireInput(this, "set-value");
      push(["value", this.id, value]);
    }

    setChecked(checked: boolean): void {
      requireInput(this, "set-checked");
      push(["checked", this.id, checked]);
    }

    focus(): void {
      push(["focus", this.id]);
    }

    // Guest dropped its handle: free the applier-side table entry. The DOM
    // node itself lives or dies with the tree, not with the handle.
    [Symbol.dispose](): void {
      if (this.id !== ROOT_ID) push(["free", this.id]);
    }
  }

  function requireInput(el: SurfaceElement, what: string): void {
    if (el.tag !== "input") {
      throw new Error(`surface: ${what} is only valid on <input>, not <${el.tag}>`);
    }
  }

  // The root grant: a fresh wrapper per call (ownership transfers to the
  // guest), always denoting the applier's container (id 0).
  function makeRoot(): SurfaceElement {
    const el = Object.create(SurfaceElement.prototype) as {
      id: number;
      tag: string;
    };
    el.id = ROOT_ID;
    el.tag = "div";
    return el as SurfaceElement;
  }

  const imports = {
    "polymorph:todomvc-spike/dom@0.0.1": {
      Element: SurfaceElement,
      createElement: (tag: string) => new SurfaceElement(tag),
    },
    "polymorph:todomvc-spike/events@0.0.1": {
      listen: (el: SurfaceElement, kind: string, token: number) => {
        checkEventKind(kind);
        push(["listen", el.id, kind, token]);
      },
    },
    "polymorph:todomvc-spike/shell@0.0.1": {
      root: () => makeRoot(),
      route,
    },
  };

  return {
    imports,
    flush() {
      if (queue.length === 0) return;
      const ops = queue;
      queue = [];
      sink(ops);
    },
  };
}
