// The frame-side half of the seam: decodes serializable ops and applies
// them to the real DOM. Re-validates independently of the surface
// front-end — this code stands where the sandboxed UI frame will stand,
// so it assumes nothing about what reached it.

import { checkAttr, checkEventKind, checkTag } from "./validate.ts";
import { attachListener, type UiEvent } from "./events.ts";
import { ROOT_ID, type Op } from "./backend-queued.ts";

export interface Applier {
  apply(ops: Op[]): void;
}

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
        case "listen": {
          checkEventKind(op[2]);
          attachListener(get(op[1]), op[2], op[3], dispatch);
          break;
        }
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
