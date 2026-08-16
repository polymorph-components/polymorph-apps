// The frame-side half of the seam: consumes serializable ops and applies
// them to the real DOM. Re-validates independently of the surface front-end
// (defense in depth — in the full framework this code runs in the sandboxed
// UI frame and cannot assume anything about what reached it).

import { checkAttr, checkEventKind, checkTag } from "./validate.ts";
import type { Op } from "./surface.ts";

export interface UiEvent {
  token: number;
  kind: string;
  key?: string;
  value?: string;
  checked?: boolean;
}

export interface Applier {
  apply(ops: Op[]): void;
}

const ROOT_ID = 0;

export function createApplier(
  container: HTMLElement,
  dispatch: (ev: UiEvent) => void,
): Applier {
  const nodes = new Map<number, Element>([[ROOT_ID, container]]);

  const get = (id: number): Element => {
    const n = nodes.get(id);
    if (!n) throw new Error(`applier: unknown node ${id}`);
    return n;
  };

  function listen(id: number, kind: string, token: number): void {
    checkEventKind(kind);
    const node = get(id);
    node.addEventListener(kind, (e) => {
      const ev: UiEvent = { token, kind };
      if (kind === "keydown") {
        const key = (e as KeyboardEvent).key;
        ev.key = key;
        if (key === "Enter") e.preventDefault();
      }
      const target = e.currentTarget as HTMLInputElement;
      if (target && typeof target.value === "string") ev.value = target.value;
      if (target && target.type === "checkbox") ev.checked = target.checked;
      dispatch(ev);
    });
  }

  function apply(ops: Op[]): void {
    for (const op of ops) {
      switch (op[0]) {
        case "create": {
          checkTag(op[2]);
          nodes.set(op[1], document.createElement(op[2]));
          break;
        }
        case "attr": {
          const [, id, name, value] = op;
          const node = get(id);
          if (value === null) {
            node.removeAttribute(name);
          } else {
            checkAttr(node.tagName.toLowerCase(), name, value);
            node.setAttribute(name, value);
          }
          break;
        }
        case "append":
          get(op[1]).appendChild(get(op[2]));
          break;
        case "remove":
          if (op[1] !== ROOT_ID) get(op[1]).remove();
          break;
        case "text":
          get(op[1]).textContent = op[2];
          break;
        case "value":
          (get(op[1]) as HTMLInputElement).value = op[2];
          break;
        case "checked":
          (get(op[1]) as HTMLInputElement).checked = op[2];
          break;
        case "focus":
          (get(op[1]) as HTMLElement).focus();
          break;
        case "listen":
          listen(op[1], op[2], op[3]);
          break;
        case "free":
          if (op[1] !== ROOT_ID) nodes.delete(op[1]);
          break;
        default:
          throw new Error(`applier: unknown op ${JSON.stringify(op)}`);
      }
    }
  }

  return { apply };
}
