# TodoMVC surface spike

TodoMVC where the **entire application is a WebAssembly component** driving a
curated DOM surface — no app JS, no app HTML, no app CSS-with-URLs. The first
conversion-checkpoint artifact for [#16] (app execution model: no app JS),
under the shape rules of [#15], running on [deltic].

**Live demo (mobile-friendly):**
https://polymorph-components.github.io/polymorph-apps/spike-todomvc/

**Scope.** Validates the wasm→DOM plumbing only: the WIT surface, the
validated op protocol, and the event-record path. The worker/frame split,
permission linker, and asset pipeline are deliberately left as seams.
Quarantined, delete-at-will, wired into no CI. The built demo is committed
at `docs/spike-todomvc/` (the repo's Pages root).

[#16]: https://github.com/polymorph-components/polymorph-apps/issues/16
[#15]: https://github.com/polymorph-components/polymorph-apps/issues/15
[deltic]: https://github.com/lann/deltic

## Architecture

```
guest (Rust → wasm component)            trusted host (JS)
┌──────────────────────────┐   WIT    ┌───────────────────────────┐
│ TodoMVC model + render   │ imports  │ surface: validate calls,  │
│ calls dom/events/shell   ├─────────>│ allocate handles, queue   │
│                          │          │ serializable ops          │
│ exports: run / on-event  │          └────────────┬──────────────┘
│          / on-route      │            op batches │ structuredClone
└────────────▲─────────────┘            (the seam) ▼
             │                        ┌───────────────────────────┐
             │  event records         │ applier: re-validate,     │
             └────────────────────────┤ id→Node map, addEventLis- │
                (token, kind,         │ tener → event records     │
                 key?/value?/checked?)│ ...applies to real DOM    │
                                      └───────────────────────────┘
```

- **`wit/todomvc.wit`** is the contract. `dom` is a WebIDL-mirror subset
  (#15 rules: `set-attribute` → `setAttribute`, get-x/set-x for IDL
  attributes, handles are resources). `events`/`shell` are framework-shaped:
  record events correlated by guest-chosen tokens (no callbacks), and the
  capability grant (`root()` hands the app its subtree; the shell owns
  routing).
- **The seam**: the surface front-end never touches the DOM; it emits plain
  op arrays which are `structuredClone`d into the applier on every batch.
  Moving the applier into a sandboxed UI frame (postMessage) or the guest
  into a worker changes *where* the two halves run, not the protocol —
  handles are allocated on the surface side, so every op is fire-and-forget
  and there is no synchronous read-back to block on across a future hop.
- **Batching**: one op batch per guest invocation (event in → ops out) —
  the "chunky protocol" posture from #15/#16.
- **Validation twice**: both halves import the same tables
  (`host/validate.ts`) and enforce independently — tag allowlist,
  per-(tag, attribute) checks, event-kind allowlist, and the one URL-typed
  attribute (`a[href]`) admitting fragment routes only. String HTML never
  crosses the boundary anywhere.

## What the artifact itself shows

`wasm-tools component wit build/todomvc.component.wasm` prints the world the
component actually imports — and it is *smaller* than the WIT: methods the
guest never calls (`remove-attribute`, `remove`) were pruned by the
toolchain. The #16 claim "the import list is the boundary, enumerable from
the artifact" is directly inspectable here: what this app can do to the
page is exactly what its binary imports.

## Findings (2026-08-16)

- **It works, everywhere the runtime does.** All imports are sync host
  functions: no JSPI, no COOP/COEP, no SharedArrayBuffer — nothing that
  excludes iOS WebKit. `Symbol.dispose` needs a polyfill on engines without
  explicit resource management (`host/polyfill.ts`, imported first).
- **Sizes** (gzip): runtime bundle 52 KB, component 14 KB, translation
  envelope 1.5 KB — ~68 KB transfer total. Translation happens at build
  time (`tools/translate.ts`); production ships no translator.
- **Interface import keys are versioned** (`polymorph:todomvc-spike/dom@0.0.1`)
  — the imports record must match the WIT id verbatim, version included.
- **Ordering semantics surface honestly**: `focus()` no-ops on elements not
  yet connected to the document, so the guest must focus *after* appending
  the subtree — found by test, fixed in the guest, and exactly the class of
  DOM semantics a worker-hop design has to keep explicit.
- **Handle lifecycle maps cleanly**: guest drops → `[Symbol.dispose]` →
  `free` op → applier table entry released, while DOM nodes live or die
  with the tree. Skeleton handles are retained for the app's lifetime;
  per-render `li` handles are dropped on each rebuild.

## Deliberately out of scope (the framework wires up here)

- The worker/frame split itself (the seam is in place; ops and events are
  already serializable data).
- The permission linker (#16: imports satisfied/stubbed per grant) — here
  the boot script links everything unconditionally.
- Asset pipeline (this app has no images/fonts; CSS is a *host* asset).
- Persistence (framework data services, not localStorage).
- A richer a11y vocabulary than native element semantics.

## Build

Requires Rust (`wasm32-unknown-unknown`), `wasm-tools`, and Deno.

```sh
just build    # → ../../docs/spike-todomvc (the Pages root)
just serve    # build + serve docs/ on :8931
```

Pipeline: `cargo build` → `wasm-tools component new` + `validate` →
build-time translate (envelope) → `deno bundle` the host → assemble the
demo dir.

## Pins

| what | version |
|---|---|
| deltic (`@deltic/runtime`, `@deltic/translator`) | `0.1.0-pre.gc4043e6` (JSR) |
| wit-bindgen (Rust crate) | `=0.60.0` |
| Rust | 1.96.0, `wasm32-unknown-unknown` |

`web/todomvc-app.css` is vendored from
[todomvc-app-css](https://github.com/tastejs/todomvc-app-css) 2.4.3 (MIT,
© TasteJS).
