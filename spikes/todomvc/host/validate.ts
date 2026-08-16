// The validation tables for the curated DOM surface — the policy half of
// polymorph-apps#16's "typed per-op checks". Imported by BOTH sides of the
// seam (surface front-end and applier) so each side enforces independently;
// in the full framework these run in different realms.

export const TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "div",
  "footer",
  "h1",
  "header",
  "input",
  "label",
  "li",
  "section",
  "span",
  "strong",
  "ul",
]);

const GLOBAL_ATTRS: ReadonlySet<string> = new Set(["class", "id"]);

const TAG_ATTRS: Record<string, ReadonlySet<string>> = {
  input: new Set(["type", "placeholder", "autofocus"]),
  label: new Set(["for"]),
  a: new Set(["href"]),
};

// The one URL-typed attribute the spike admits: fragment-only routes.
const FRAGMENT_HREF = /^#(\/[a-z-]*)?$/;

export const EVENT_KINDS: ReadonlySet<string> = new Set([
  "click",
  "dblclick",
  "input",
  "change",
  "keydown",
  "blur",
]);

export function checkTag(tag: string): void {
  if (!TAGS.has(tag)) {
    throw new Error(`surface: tag <${tag}> is not in the allowlist`);
  }
}

export function checkAttrName(tag: string, name: string): void {
  if (GLOBAL_ATTRS.has(name) || TAG_ATTRS[tag]?.has(name)) return;
  throw new Error(`surface: attribute '${name}' is not allowed on <${tag}>`);
}

export function checkAttr(tag: string, name: string, value: string): void {
  checkAttrName(tag, name);
  switch (`${tag} ${name}`) {
    case "input type":
      if (value !== "text" && value !== "checkbox") {
        throw new Error(`surface: input type '${value}' is not allowed`);
      }
      return;
    case "input autofocus":
      if (value !== "") {
        throw new Error("surface: autofocus takes no value");
      }
      return;
    case "a href":
      if (!FRAGMENT_HREF.test(value)) {
        throw new Error(
          `surface: href '${value}' rejected (fragment routes only)`,
        );
      }
      return;
    default:
      return;
  }
}

export function checkEventKind(kind: string): void {
  if (!EVENT_KINDS.has(kind)) {
    throw new Error(`surface: event kind '${kind}' is not in the allowlist`);
  }
}
