// The guest-facing half of the curated DOM surface: implements the WIT
// imports (`dom`, `events`, `shell`) as a resource class plus free
// functions. ALL guest-facing validation lives here — every backend
// receives already-checked primitives at the same call sites, so trap
// points are identical across backends by construction.

import {
  checkAttr,
  checkAttrName,
  checkEventKind,
  checkTag,
} from "./validate.ts";
import type { Backend, Rep } from "./backend.ts";

export interface Surface {
  /** The imports record for `instantiate` (keys are verbatim WIT ids). */
  imports: Record<string, Record<string, unknown>>;
  /** End-of-invocation flush boundary (see the ordering spec in the WIT). */
  flush(): void;
  /** Resolve once flushed ops are applied (no-op for immediate backends). */
  drain(): Promise<void>;
}

export function createSurface(
  backend: Backend,
  route: () => string,
): Surface {
  class SurfaceElement {
    readonly rep: Rep;
    readonly tag: string;
    readonly isRoot: boolean = false;

    constructor(tag: string) {
      checkTag(tag);
      this.tag = tag;
      this.rep = backend.create(tag);
    }

    setAttribute(name: string, value: string): void {
      checkAttr(this.tag, name, value);
      backend.attr(this.rep, name, value);
    }

    removeAttribute(name: string): void {
      checkAttrName(this.tag, name);
      backend.attr(this.rep, name, null);
    }

    appendChild(child: SurfaceElement): void {
      backend.append(this.rep, child.rep);
    }

    remove(): void {
      backend.remove(this.rep);
    }

    setTextContent(text: string): void {
      backend.text(this.rep, text);
    }

    setValue(value: string): void {
      requireInput(this, "set-value");
      backend.value(this.rep, value);
    }

    setChecked(checked: boolean): void {
      requireInput(this, "set-checked");
      backend.checked(this.rep, checked);
    }

    focus(): void {
      backend.focus(this.rep);
    }

    // Guest dropped its handle: free backend bookkeeping. The DOM node
    // itself lives or dies with the tree, not with the handle.
    [Symbol.dispose](): void {
      if (!this.isRoot) backend.free(this.rep);
    }
  }

  function requireInput(el: SurfaceElement, what: string): void {
    if (el.tag !== "input") {
      throw new Error(
        `surface: ${what} is only valid on <input>, not <${el.tag}>`,
      );
    }
  }

  // The root grant: a fresh wrapper per call (ownership transfers to the
  // guest), always denoting the backend's container.
  function makeRoot(): SurfaceElement {
    const el = Object.create(SurfaceElement.prototype) as {
      rep: Rep;
      tag: string;
      isRoot: boolean;
    };
    el.rep = backend.root;
    el.tag = "div";
    el.isRoot = true;
    return el as SurfaceElement;
  }

  return {
    imports: {
      "polymorph:todomvc-spike/dom@0.0.1": {
        Element: SurfaceElement,
        createElement: (tag: string) => new SurfaceElement(tag),
      },
      "polymorph:todomvc-spike/events@0.0.1": {
        listen: (el: SurfaceElement, kind: string, token: number) => {
          checkEventKind(kind);
          backend.listen(el.rep, kind, token);
        },
      },
      "polymorph:todomvc-spike/shell@0.0.1": {
        root: () => makeRoot(),
        route,
      },
    },
    flush: () => backend.flush(),
    drain: () => backend.drain(),
  };
}
