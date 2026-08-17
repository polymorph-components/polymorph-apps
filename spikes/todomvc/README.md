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

## Backends: the semantically-equivalent fast paths

Per the fast-path plan recorded on [#15], the surface front-end owns all
guest-facing validation and drives one of three **backends** implementing
the same ordering spec (written in `wit/todomvc.wit` on the `lab` world):
ops apply in call order; a flush boundary falls at the end of each export
invocation and at each guest suspension point; ops emitted before a trap
are applied; within a boundary, application is atomic w.r.t. paint.

| backend | what | role |
|---|---|---|
| `direct` | validate → mutate the Node held as the resource rep; no ops, no clone, no id map | same-realm production path — the shape of a future native WebIDL binding |
| `queued` | serializable op batches + `structuredClone` + re-validating applier | debug/canary configuration; proves the seam every batch |
| `channel` | the queued protocol over a real `MessageChannel` (postMessage clones; events round-trip) | faithful stand-in for the worker/frame split |

The demo takes `?backend=` (default `direct`).

**The equivalence harness** ([harness.html](https://polymorph-components.github.io/polymorph-apps/spike-todomvc/harness.html))
makes "semantically equivalent" a checked property: the same guests run the
same scripts on every backend — 15 TodoMVC steps (synthetic event records
plus real DOM clicks) with full-DOM serialization compared stepwise
(attributes, input value/checked props, focus marker), and 8 probe cases
from a violation guest (`lab/`) compared as trap vectors, including the
flush-on-trap rule (a visible legal mutation before the violating call must
land on every backend). Status: **PASS**, 3 backends.

**The churn bench** ([bench.html](https://polymorph-components.github.io/polymorph-apps/spike-todomvc/bench.html),
`?n=` rows; li+span per row ≈ 6 surface calls) — Chromium, aarch64 linux,
2026-08-16, n=5000 (30k surface calls in one invocation):

| backend | create 5000 (ms) | µs/call | update med (ms) | clear (ms) |
|---|---|---|---|---|
| direct | 31.7 | 1.06 | 1.0 | 1.1 |
| channel | 32.8 | 1.09 | 1.3 | 2.5 |
| queued | 46.8 | 1.56 | 1.5 | 2.7 |

Readings: the postMessage hop costs ~3% at batch sizes UI code never
reaches; the explicit-clone canary costs ~47% and stays a debug
configuration; a heavy real frame (hundreds of ops) is ~0.1 ms of
boundary+DOM cost on any backend. The #15 expectation holds — the glue tax
is a VDOM-op-rate problem, not a UI-rate problem, so the contract-level
accel option stays shelved and the bridge position is "delete scaffolding
when native bindings arrive".

## Two guests, one world: the dioxus guest

`guest-dioxus/` implements the **same WIT world** with the app written in
[dioxus](https://dioxuslabs.com) 0.7 `rsx!` — a real framework's VDOM
diffing running in-guest, its patch stream applied through the surface
(demo: [`?guest=dioxus`](https://polymorph-components.github.io/polymorph-apps/spike-todomvc/?guest=dioxus)).
The framework-support research and decision (2026-08-16):

- **Dioxus chosen.** `dioxus-core` is renderer-agnostic in practice, not
  just in theory: `WriteMutations` is a public seam (Blitz/dioxus-native
  ship on it), the crate graph is wasm-bindgen-free, and the VirtualDom
  drives synchronously (`handle_event` → `process_events` →
  `render_immediate`) — a perfect fit for a reactor guest. The glue is
  ~450 lines: a `WriteMutations` impl over surface imports (stack machine
  with guest-side shadow children for template paths, cribbed from
  dioxus-native-dom), an `HtmlEventConverter` mapping surface event
  records to dioxus event data, and listener tokens = dioxus `ElementId`s.
- **Leptos rejected for now.** tachys 0.2 (leptos 0.8) hardcodes
  `pub type Rndr = dom::Dom` — the 0.7-era generic renderer was
  monomorphized away for compile times, and the alternate renderers are
  commented out in the source. Supporting it means forking its view
  layer. Its standalone `reactive_graph` remains attractive for a future
  hand-rolled fine-grained renderer.
- **One dependency lie needed patching**: dioxus-core's mandatory
  `subsecond` (hot-patch runtime) links js-sys/wasm-bindgen on *all*
  wasm32 targets — "wasm32 implies browser" strikes again — which poisons
  componentization. `vendor/subsecond/` is an API-identical inert stub
  (release semantics: call directly), applied via `[patch.crates-io]`.
- **Surface additions the framework forced** (the exact prerequisite list
  predicted): `create-text-node` (mixed content like the
  `<strong>{n}</strong> items left` counter), and `before`/`after`
  (ChildNode mirrors) for positional insertion — all structural, all
  validator-checked, two new probe cases pin text-node restrictions.
- **Sizes**: dioxus component 366 KB raw / **130 KB gz** vs 37 KB / 14 KB
  hand-written — the framework tax, paid once per app.
- **Known gaps** (documented, not hidden): no `onmounted`/focus bridging
  (the edit field doesn't auto-focus in the dioxus guest — needs a
  mounted-data story over the surface), `preventDefault`/
  `stopPropagation` from handlers don't cross the record boundary
  (bubbling is delegated to the real DOM; dioxus is told `bubbles=false`),
  and only the six surface event families convert.


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
- **`autofocus` is not expressible on the surface** (2026-08-16, found by
  the harness on its first run): UA-initiated focus is processed at
  rendering opportunities and only when nothing else holds focus, so it
  diverges across backends by timing, not semantics. The attribute is
  rejected; focus is the explicit `focus()` op. General rule: attributes
  that *trigger UA behaviors* (autofocus and friends) are outside the
  equivalence envelope until specced op-like.
- **Backend equivalence is cheap to hold**: the three backends share the
  validation tables and the event-record builder, differ only in
  application strategy, and the harness pinned them identical on the first
  honest run (after the autofocus fix). Trap messages surface deltic's
  unbranded-throw guidance — expected: surface violations are deliberate
  traps, not WIT errors, per #16.

## Deliberately out of scope (the framework wires up here)

- The real worker/frame split (the `channel` backend proves the protocol
  over a genuine MessageChannel; moving its two halves into a worker and a
  sandboxed frame is placement, not design).
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

Pipeline: `cargo build` (todomvc + lab guests) → `wasm-tools component new`
+ `validate` → build-time translate (envelopes) → `deno bundle` the host
(one bundle, three pages: demo / harness / bench) → assemble the demo dir.

## Pins

| what | version |
|---|---|
| deltic (`@deltic/runtime`, `@deltic/translator`) | `0.1.0-pre.gc4043e6` (JSR) |
| wit-bindgen (Rust crate) | `=0.60.0` |
| dioxus (`dioxus`, `dioxus-core`, `dioxus-html`) | `=0.7.10` (subsecond stubbed, see `vendor/`) |
| Rust | 1.96.0, `wasm32-unknown-unknown` |

`web/todomvc-app.css` is vendored from
[todomvc-app-css](https://github.com/tastejs/todomvc-app-css) 2.4.3 (MIT,
© TasteJS).
