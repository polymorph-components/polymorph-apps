# visor/ — the framework layer, graduating out of the spikes

The visor is the framework-owned trusted UI and the isolation seams
around sandboxed apps (#22's rulings; #16's per-surface frames; #5's
disclosure model). It began life inside the spikes — the DOM-op seam in
`spikes/todomvc/host/`, the frame isolation and system UI in
`spikes/demo/` — and both spikes now consume it from here instead of
reaching into each other's directories.

Three layers, one trust story:

- **`surface/`** — the app seam. The `Backend` protocol and its
  implementations (`direct`, `queued`, `channel`, plus the frame side
  of `frame`), the op `applier` with independent re-validation
  (`validate.ts`), the guest-facing WIT `surface`, the serialized
  guest-call `runner` (whose `pause`/`resume` is the visor's input
  suspension), and the `events` records. Everything an app's DOM ops
  and events cross, validated on both sides of every seam.

- **`frame/`** — iframe isolation. `frame-backend.ts` (trusted side)
  creates a `sandbox="allow-scripts"` iframe — no `allow-same-origin`,
  so the app's document gets an OPAQUE ORIGIN and structurally cannot
  read the visor's DOM, styles, or storage. `frame.ts` + `frame.html`
  are the code the visor ships INTO that frame: the applier wired to a
  MessagePort, height reporting, coarse theme (never the anchor
  colour). The queued-op protocol is identical to `channel`; only the
  realm changes.

- **`ui/`** — the system UI core. `initVisor()` renders the strip
  (two-line context, identity cluster), announcements
  (re-render-not-restore), the anchor-colour discipline (scoped custom
  properties, never `:root`; announced-never-silent resets), the
  identity record, and the drawer host (tenancy with precedence,
  arming delay, ownership-aware context restore). Storage keys are the
  consumer's (`pm-demo-*`, `pm-todomvc-*`); the element ids
  (`#visor-strip` and friends) are fixed — position is a trust anchor.
  `visor.css` carries the visor-owned styles both pages link.

Consumers: `spikes/demo` (full flows: petnames, credentials, storage
dialog, pairing) and `spikes/todomvc` (consent/kill tenants, frame
backend by default). Source-level invariants for all of it are
enforced by `spikes/demo/scripts/check-invariants.sh`, whose greps
follow the code here (each check names its files); the demo's
Playwright e2e suite (`spikes/demo/e2e/`) is the behavioral gate.
