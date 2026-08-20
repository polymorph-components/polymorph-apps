// The direct backend: same-realm fast path (option 1 of the #15 fast-path
// plan). Validation already happened in the surface front-end; each
// primitive touches the real DOM immediately, with the Element itself as
// the rep — the exact shape of a future native WebIDL binding
// (validate → call), with no op arrays, no clone, no id→Node map.
//
// Defense-in-depth note: the applier's re-validation layer exists where a
// REALM boundary exists. Same-realm direct application has one validation
// layer by design; the cross-realm backends keep two.

import type { Backend } from "./backend.ts";
import { attachListener, type UiEvent } from "./events.ts";

export function createDirectBackend(
  container: HTMLElement,
  dispatch: (ev: UiEvent) => void,
): Backend {
  return {
    root: container,
    create: (tag) => document.createElement(tag),
    textNode: (data) => document.createTextNode(data),
    attr: (rep, name, value) => {
      const el = rep as Element;
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    },
    append: (parent, child) => (parent as Element).appendChild(child as Node),
    before: (ref, node) => (ref as ChildNode).before(node as Node),
    after: (ref, node) => (ref as ChildNode).after(node as Node),
    remove: (rep) => {
      if (rep !== container) (rep as ChildNode).remove();
    },
    text: (rep, text) => {
      (rep as Node).textContent = text;
    },
    value: (rep, value) => {
      (rep as HTMLInputElement).value = value;
    },
    checked: (rep, checked) => {
      (rep as HTMLInputElement).checked = checked;
    },
    focus: (rep) => (rep as HTMLElement).focus(),
    listen: (rep, kind, token) =>
      attachListener(rep as Element, kind, token, dispatch),
    free: () => {},
    flush: () => {},
    drain: () => Promise.resolve(),
  };
}
