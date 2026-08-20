# The end-to-end TodoMVC demo (#20, G6 + G7)

**The #20 target artifact, in a browser**: TodoMVC where the app is a
wasm component driving a curated DOM surface (the todomvc spike), the
model is the `polymorph-data:tasks` data service, and the service is
the real engine composite — automerge change-DAG + keyhive (BeeKEM
epochs) + subduction sync + the SigV4 bucket client + the iroh
endpoint — running **under deltic in the page**. Three panes, one page:

| pane | role | sync path |
|---|---|---|
| Alice — laptop | wire hub, bucket owner | live (n0's public relay by default) + bucket |
| Bob | collaborator | live (n0's public relay by default) + bucket (link tier) |
| Alice — tablet | second device, **zero connections ever** | your bucket (Storage… dialog) |

**Two storage providers behind one engine surface** (#19): S3-compatible
(name secrecy + K_p, cooperative revocation) and **Dropbox** (shared
links as pull capabilities, hard server-side revocation) — chosen in a
dialog, same beats either way.

Demo beats, all driven through the real UIs and verified:
adds/toggles/edits converge across all three replicas; the tablet cold
boots from the bucket and authors through it; **Bob: bucket pull** shows
the pull tier directly (he holds no storage account — S3: unsigned GETs
by derived name; Dropbox: his standing pickup link under app auth);
**Revoke Bob** mid-demo: alice's next task reaches the tablet while
bob's pane holds ciphertext it can no longer decrypt (`undecryptable: 1`
in his status line) *and* his bucket pull is refused — on S3 the
cooperative K_p darkness, on Dropbox a hard `pickup link refused (409)`
from the provider. Cryptographic exclusion and pull-tier exclusion,
visible in a todo list.

## Storage config as a sandboxed component (#22)

The #22 provisional ruling says the visor is trusted shell code, with one
named exception: *"third-party visor-ish things (a storage backend's
config panel) are **apps** — own sandboxed region, own grants, launched
from the visor, never rendered as the visor."* This demo implements exactly
that, and it is the first place the framework's capability story is
visible in UI:

```
visor (page JS, trusted)           panel component (sandboxed, per-provider)
  Storage… button                    guest-panel-s3       — dom/events/shell ONLY
  dialog frame + provider tabs         "pure component: cannot reach the network"
  #panel-region (the grant) ────────►  guest-panel-dropbox — + oauth-broker
  carries the returned config                                + fetch scoped to
  to engine.init-store                                         api.dropboxapi.com
```

- The panel is mounted through the **same curated-DOM surface machinery
  as the app** (`createBackend`/`createSurface`, a `root()` grant that
  is the dialog region) — position, not style, marks the boundary; the
  region is visibly inset and labeled "sandboxed panel".
- **The visor brokers OAuth.** Navigation, popups and redirect handling are
  visor capabilities a sandboxed panel must not have, so the Dropbox
  panel calls `oauth-broker.authorize(app-key)` and the visor runs the
  whole PKCE ceremony (S256 challenge, popup, `postMessage` relay
  through the redirect, code exchange) and returns only the tokens. The
  panel never sees the ceremony; the app guests never see any of it.
- The panel's `fetch` import **is** the per-destination network grant:
  the visor's shim refuses any host but `api.dropboxapi.com` with a WIT err
  (`__demo.panelFetch` exposes it so the refusal is demonstrable, not
  merely asserted). Its S3 sibling gets no fetch import at all — the
  #21 pure-vs-egress capability-profile contrast, in one dialog.

## Architecture

```
per pane (×3, one browser page):
  app component (109 KB)            engine composite (10.8 MB)
  todomvc surface guest             keyhive+automerge+subduction+
  imports: dom/events/shell         bridge+S3/Dropbox client+iroh
  + polymorph-data:tasks  ────────► exports: tasks + driver
        │  (import wired DIRECTLY to the engine instance's export —
        │   same embedder, same value conventions, same exception brand)
  deltic runtime (jsr @deltic/runtime 0.1.0) + @deltic/wasi (incl. the
  fetch-backed wasi:http fragment) + deltic ports from JSR
  (webcrypto / websocket / webrtc, all `jsr:@polymorph/*@0.1.0`) + sockets stub
```

- The engine composite is byte-identical to `spikes/tasks-engine`'s
  (`just engine` delegates there). Translation: ~200 ms, 253 KB envelope.
- The app guest is `spikes/todomvc`'s hand-written guest with the model
  swapped from in-guest memory to the tasks service (async exports + a
  `poll` export for remote-change re-render; string task ids; the
  surface protocol untouched). wasm32-unknown-unknown, no WASI.
- Boot choreography (`host/demo.ts`): identities → tablet enrollment by
  pasted contact card → alice⇄bob wire over the relay → partition
  create → members (individual grants; the group form is proven
  headless in tasks-engine G3) → seal → pulls gated on
  `kh-knows-agent(doc)` → subscriptions → bucket grant/flush → tablet
  cold boot → apps mounted.

## The visor, and where untrusted pixels live

Two changes make the trust boundary legible rather than implied.

**A persistent visor strip** (#22) carries identity in the one region a
component can never paint. Its background is the **user's own colour** —
randomised on first run, changeable from a constrained palette (fixed
lightness/chroma in OKLCH, so contrast cannot be customised away), and
never disclosed to components. It stays CONSTANT while secondary
surfaces come and go: an anchor that changed per component would stop
being an anchor. While a provider panel is open, the strip names it — a
recognition chip whose colour is **assigned at first sight** (a TOFU
trust table, locally unique), its name QUOTED and clamped, then
the visor's own words ("drawn by the component, not by the visor") — plus a
loud **"NEW — first time this component draws here"** marker on first
sight, which is the moment impersonation would land. The same assigned
colour edges the panel region, so the rectangle and its label visibly
agree.

Recognition colours are **never derived**. Two derivations died here to
one attack — making the visor's own strip vouch the wrong colour: deriving
from component bytes let an impersonator grind its artifact until the
strip assigned it the target's colour (and reshuffled on every
legitimate update); deriving from HMAC(user-secret, name) closed the
grind but reopened it through the other input, since names are
self-declared. Assignment also buys what no derivation can: local
uniqueness — hues are handed out from the unused set, so two trust
records on one device never share a mark while the palette lasts. The
trust-record key must be unforgeable provenance (here: the artifact
name as fetched by the visor from its own origin; with #3/#10, the
publisher's verifying key) — a self-declared name must never be able to
look up someone else's record. A reset (storage eviction) is
ANNOUNCED, never silent — an anchor that quietly changes trains the user
that it changes.

This is deliberately NOT the personalization secret #22 dropped: it
demands no user action at a decision point and no per-prompt
verification, so it fails toward "something looks off" rather than "I
forgot to check". It is a SECONDARY anchor behind position.

**Component surfaces run in real sandboxed iframes** (#16):
`sandbox="allow-scripts"` with no `allow-same-origin`, so each surface
has an opaque origin, and the op protocol crosses a `MessagePort` to a
frame-side applier that re-validates independently. Apps and panels no
longer render into the visor's document at all. `__demo.frameProbe()`
asserts the property (`sameOriginReachable: false`), and the anchor is
now out of reach by construction rather than by allowlist — verified:
`--visor-bg` is scoped to the strip ELEMENT, not `:root`, so it does
not even inherit into a region.

The visor also owns the **commit**: Save/Cancel live outside the granted
region and call the panel's `commit()`, which returns a config or
refuses with its own reason. A panel owning its own Save button owns the
user's sense of what saving means.

## Device pairing + user-system partition (#10, #36)

`host/pairing-mock.ts` implements the async surface pinned in
`spikes/tasks-engine/PAIRING.md` §3 (`pair-*`/`us-*`/`user-create`) as
an in-page mock: two mock "devices" share one `MockPairingNetwork`, so a
code offered on one pane is claimable on the other and both compute the
same SAS from the same transcript — real UI development without the
real engine composite. `host/pairing-visor.ts` is the visor-owned
rendering of both ceremonies (it is also the ONLY module allowed to
render a pairing code or a SAS — `scripts/check-invariants.sh`'s new
check [6/6] holds that line):

- **Join** (new device): "join existing account" → QR (a vendored,
  self-contained encoder, `host/vendor/qrcodegen.ts`) + the 79-char code
  in groups of 4 → SAS screen → **light** confirm ("I initiated this" +
  SAS match — nothing secret is typed, no arming delay) → the adoption
  announcement ("this device now follows your profile: ‹name›, your
  colour"), with the pane's hue visibly repainted to the synced value.
- **Add** (trusted device): "add a device" → paste/type the code → SAS
  screen → **heavy** ceremony: a statement of consequence ("full access
  to everything in your account"), the #22 arming delay (ported
  verbatim, same 700ms constant as the credential drawer), and a
  device-name field that is never prefilled from anything the joiner
  sent — the visor's own words are the user's own words. Completion adds
  the new device to a devices list.
- **State migration**: visor hue, display name and the petname/marks
  table move to `us-*` driver calls; `localStorage` demotes to a **boot
  cache** (`host/pairing-visor.ts`'s `loadBootCache`/
  `reconcileFromDriver`) — render from cache, reconcile after driver
  init, announce any diff (never silent). The keystore (device-local
  signing key handles) is untouched by this.
- **Announcements** drain `us-events` into a status surface with the
  same priority-over-ambient-telemetry pattern as the three-pane demo's
  beat statuses (sticky for 12s once a consequential message writes it):
  `profile-changed`, `mark-conflict-repaired` (renders as
  NEW-with-explanation for a `needs-reconfirm` mark), `device-added`,
  `device-revoked`.

Try it: `just pairing-site && just pairing-serve`, then open
`http://127.0.0.1:8601/pairing-demo.html` — two panes, one page, no
engine/wasm/relay/bucket dependency (that is the point: this gate is
independent of Track A's engine work landing). Playwright gate (real
headless Chromium): `spikes/demo/tests/pairing.spec.mjs` (see that
file's header for the exact run recipe) asserts SAS equality across
panes, that the arming delay actually gates the add-side confirm, that
announcements render, and that the join pane's hue visibly adopts the
synced value.

Swapping the mock for the real composite (after Track A lands) touches
only the driver construction in `host/pairing-demo.ts` (or wherever the
three-pane demo wires it in next) — `host/pairing-visor.ts` is written
against the `PairingDriver` interface alone and does not know the
difference.

## Deployment

The hosted build is **continuously deployed**: `.github/workflows/pages.yml`
runs `scripts/setup.sh` (sibling ports pinned by commit, toolchain from
`rust-toolchain.toml`, `wasm-tools`/`wac`/`just` pinned), builds the site
from source on every push, and deploys `docs/` to Pages from `main`. PRs
build the site too but do not deploy — a broken demo fails the PR
instead of the site.

`docs/spike-demo/` is **generated, not committed** (cutover completed
2026-08-18: Actions deploy proven via the served build stamp, Pages
source switched, then the artifacts deleted from git — four rebuilds of
an ~11 MB engine composite had landed in history before that). `just
pages` writes the same tree locally for preview. Bumping a sibling pin
in `scripts/setup.sh` is deliberate: those ports carry embedder
conventions that have broken this demo before.

## Run it

```
just serve    # build engine+app, translate, bundle, serve on :8600
```

Open http://127.0.0.1:8600/. The live path rides n0's public relay
(`?relay=…` overrides, e.g. a local `iroh-relay --dev`); the bucket
pane activates through the **Storage…** dialog — either an
S3-compatible endpoint whose CORS admits the page origin (`just infra`
runs a local MinIO with open CORS, plus a local relay), or **Dropbox**:
paste an app key + secret from a Dropbox app (App folder access;
scopes `files.content.*`, `sharing.*`, `account_info.read`) and press
*Connect Dropbox* for the PKCE flow, or paste a console-generated
access token. Add `http://127.0.0.1:8600/` as an OAuth redirect URI in
the app console for the Connect path. Hosted build:
https://polymorph-components.github.io/polymorph-apps/spike-demo/
— same story: public relay out of the box, bring your own bucket.

Requires `spikes/tasks-engine`'s pinned iroh-relay + endpoint wasm
(`just -f ../tasks-engine/justfile relay-bin`; endpoint wasm still via
`IROH_CHECKOUT` — see that spike's README "JSR pins" section for why)
and its MinIO fetch (run that spike once). The deltic ports
(webcrypto/websocket/webrtc-datachannels) are JSR pins now, no sibling
checkout (see `deno.json`'s header comment).

Headless bring-up phases (`just bringup solo|wire|bucket`) retire the
platform layers one at a time under Deno; `wire soak` runs a 30 s
post-revocation stress loop.

Memory/backpressure probes (added while chasing a reported lockup):

```sh
deno run -A host/leak-probe.ts 90 pulls   # engines + live subscriptions, RSS
deno run -A host/table-probe.ts           # 400 pulls, guest table sizes + RSS
deno run -A host/cdp-heap.ts <url> 300    # real headless Chromium heap via CDP
```

`cdp-heap.ts` needs a Chromium binary (`CHROME=…`, or the Playwright
cache default) and forces a GC at the end — the only reading that
separates retention from uncollected garbage. In-page, `__demo.health()`
reports background queue depth and per-timer skip counts.

## Findings

- **deltic 0.1.0 renamed the embedder conventions** (`WitError` →
  `ComponentException`; variant envelopes `{tag, val}` → `{kind,
  value}`). This USED TO be a problem: earlier sibling-checkout pins of
  the three deltic ports predated the rename, so websocket was vendored
  here with a mechanical migration while webcrypto/webrtc happened to be
  shape-compatible on the engine's paths. Resolved (jsr-pins branch):
  `jsr:@polymorph/{webcrypto,websocket,webrtc-datachannels}@0.1.0` all
  publish against `@deltic/runtime@^0.1.0` — confirmed by reading each
  package's source, including `websocket.ts`, which already imports
  `ComponentException` (the exact migration the vendored copy was
  performing by hand). All three now come straight from JSR; the
  vendored `host/ports/websocket.ts` is retired (deno.json's import map
  points at the JSR package instead).
- **Browser bundling of the webrtc port** drags its lazy node backend
  (`node:*` statics from werift) into the bundle; `--external
  node-datachannel --external werift` keeps the lazy import lazy — the
  browser never evaluates it (native `RTCPeerConnection` wins).
- The engine composite **instantiates in ~30–50 ms** in the page; the
  full crypto stack (BeeKEM seal/open, SigV4, Ed25519 via the webcrypto
  port) runs at interactive latency.
- The first-sync **policy race** (recorded in the tasks-engine spike)
  reproduces at browser timings: gate the first pull on
  `kh-knows-agent(doc)`.
- **One in-browser subscription-push miss was observed** (a task
  authored right after boot never pushed; a fresh boot delivered
  pushes fine). Background reconciliation pulls (2.5 s, empty diff when
  in sync) bound the staleness; a 30 s Deno soak of the same loops
  (88 cycles, post-revocation refusals included) shows no engine-side
  defect. Needs a minimal repro upstream.
- **Background driver calls are serialized page-wide** (one promise
  chain): an earlier build with overlapping interval-driven calls into
  the same instances froze the page once. Not reproduced under Deno;
  suspected interaction with the embedder's instance scheduling —
  serialize until understood.
- Screenshot/capture tooling against the page (paseo webview) times out
  — background tabs never paint; validation is DOM-assertion-based.
- **The `{kind, value}` variant envelope bit again.** The rename was
  already recorded above, and the first cut of the new `store-config`
  variant still shipped `{tag, val}` (a TS union modeled on a *port's*
  internal error type, not on the embedder's wire convention). It
  surfaced only at the first live `init-store`:
  `expected a { kind, value? } value, got a Object`. Host-side variant
  construction has no type-level protection against this — the
  embedder's convention is a runtime contract, so the check belongs in
  a smoke path, not in review.
- **Transient beat results were being erased by the stats refresh.**
  Pull outcomes and the revocation guarantee note are the *payload* of
  those beats, and a 4 s `stats()` tick overwrote them within one frame.
  Status lines are now **sticky for 12 s** when a beat writes them
  (stats stand down). Worth carrying into the framework's visor: a
  status surface that mixes ambient telemetry with consequential
  one-shot messages needs priority, not last-writer-wins.
- **A bare transport error is undiagnosable, and one of them killed the
  whole setup.** A live run failed with
  `fetch: send: ErrorCode::InternalError(Some("NetworkError…"))` — no
  method, no host, no operation — after ~20 s of a single
  "configuring storage…" line. Three fixes, all in this commit: every
  provider request **names itself** in transport errors
  (`PUT host/path: transport failed after 3 attempts: …`); transport
  failures (never statuses — 429/5xx go to the caller untouched) **retry
  up to 3×**, which is safe because every provider call here is
  idempotent by construction; and setup **announces each step**
  (`configuring storage: grant: bob (pickup link)…`), so a failure says
  *which* of the ~20 sequential calls died and the remaining message is
  actionable advice rather than "check endpoint + CORS".
- **A duplicate "Save & connect" re-ran the entire setup**, re-minting
  container links and republishing pickups under the first run. The
  guard's placement is the subtle part: the background chain serializes
  work, so a flag checked *inside* the job always finds the previous run
  finished — it has to be claimed **synchronously at call time**.
  (Verified by driving two calls in one tick; the second is refused.)
- **Unversioned assets served returning visitors a stale bundle.** The
  page loaded `demo.js` by bare name, so a rebuilt demo kept running the
  cached script against fresh components — it cost an hour of chasing a
  fix that was already deployed. The build now stamps a mutable root
  (`<meta name="pm-build">` + `demo.js?v=…`) and artifacts inherit the
  stamp: NOTES §Release integrity's bootloader shape in miniature, and
  the thing that makes a Pages republish actually take effect.
- **Console-generated Dropbox tokens expire in ~4 h**, and the failure
  is now legible (`create_folder_v2 …: 401 expired_access_token`). The
  OAuth path is the real fix: PKCE with `token_access_type=offline`
  returns a refresh token, and the engine refreshes on 401 and retries
  once. Paste-a-token remains the dev fallback with a stated cliff.
- **Fixed-rate timers with no in-flight guard were the lockup.** Every
  periodic driver — app `poll` (400 ms x 3 panes), reconciliation pulls
  (2.5 s), auto bucket-sync (4 s), stats (4 s) — appended to an
  unbounded promise chain unconditionally, while the work behind them
  routinely outlives the period (consumer-API storage runs 1-3 s/op).
  Fixed-rate scheduling + slower-than-period work diverges: the queue
  *is* the leak, and user input ends up behind hundreds of pending jobs
  (sluggish, then wedged, then dead). All periodic work now **skips a
  tick whose predecessor is still running** — correct semantics anyway:
  a reconciliation pull is a refresh, not a transaction. Measured with a
  1.5 s/op delay proxy in front of MinIO: **180 ticks skipped in 3
  minutes** (jobs the old code would have queued), background depth
  bounded at 3-4, and a UI-path task add still completing in **3 ms**
  while storage churns. `__demo.health()` exposes depth + per-timer skip
  counts.
- **The "leak" was the queue, plus a measurement artifact — chased to
  ground.** After the backpressure fix, growth persisted in the paseo
  webview (~1 MB/s, monotonic over 5 minutes), so it was bisected:
  500 driver/tasks calls leak nothing; app polls at 400 ms x 3 for 75 s
  are flat; **reconciliation pulls leak** (35 MB / 75 s). Two independent
  checks then cleared the engine: `host/table-probe.ts` runs 400 pulls
  headless and shows every guest table flat with **RSS plateauing at
  ~300 MB**, and a real headless **Chromium via CDP** (`cdp-heap.ts`)
  runs the identical page for 150 s — heap sawtooths normally and
  **returns to 7.5 MB after a forced GC, net -1.5 MB**. So there is no
  leak in the engine, in subduction, or in the deltic browser ports; the
  unbounded growth was (a) the queue divergence above, which retains one
  closure per queued job, and (b) the paseo webview's own instrumentation
  retaining objects (and/or never idling long enough to GC). **Measure
  memory in a real browser, not in the automation webview** — the
  earlier version of this section blamed the port layer on the strength
  of webview numbers, and was wrong.
- **One real leak was found and fixed on the way**: the engine's `syncs`
  table inserted a result per sync and never removed it, while
  `sync-status` only read it — unbounded by construction at ~48 syncs a
  minute. Statuses are one-shot by contract, so the entry is now removed
  as it is read, and `stats()` publishes the guest's table sizes
  (`tables syncs=… conns=… parts=…`) precisely because a growth bug in
  them is invisible from outside the component.
- **Four bugs surfaced by moving surfaces into frames**, all of the same
  family — a surface's lifetime and its measurements stop being things
  the shell can observe directly:
  1. **A component frame outlived its dialog.** Mounting is async
     (artifact fetch + frame handshake) and `<dialog>` closes natively on
     ESC, so a late mount, or any close path other than the buttons,
     left a LIVE component holding a granted rectangle nobody could see.
     Fixed with a generation counter checked after every await, plus
     retirement hung off the dialog's `close` event — the one place that
     sees every path.
  2. **Height reporting raced the render-blocking stylesheet.** The
     frame's first (and only) height report was taken before layout
     existed, so it truthfully said 0, the shell clamped to its floor,
     and a quiet app never corrected it. Now a `ResizeObserver` reports
     continuously.
  3. **`scrolling="no"` collapses `scrollHeight`.** Under
     `overflow:hidden` it equals the clipped viewport, so the frame kept
     reporting the shell's own clamp back to it. Measure the body's flow
     box instead.
  4. **The frame accepted a port from any sender.** Sibling frames are
     reachable via `parent.frames[i]`, so the first sibling to post a
     port could have become another frame's shell. The embedder check is
     `e.source === window.parent`; origin cannot be used, because every
     sandboxed frame reports "null".
- **The paseo webview does not deliver `<dialog>` close events.** Native
  `close()` flips `.open`, manual `dispatchEvent` delivers fine, but the
  engine-queued close event never arrives — and modals also close
  spuriously without any event. Retirement therefore triggers on the
  **state change** (a MutationObserver on the `open` attribute) with the
  close event kept as belt-and-braces. Same lesson as the memory-leak
  hunt: the automation webview is not a reference environment — the
  companion CDP probe confirms real Chromium delivers the event and
  tears down correctly.
- **Isolation costs the old verification path**: the visor (and any test
  driver) can no longer read into surfaces, and `browser_snapshot` stops
  at the iframe. Driving is now engine-level assertions plus frame
  self-reports; UI-level driving needs an explicit frame-side hook.
- **A diagnostic that dies with the handshake reports "no faults" for a
  frame that is on fire**: the fault channel first hung off the same
  window listener the handshake removed. It gets its own listener now.
- **Panel teardown is a deltic open question** (same one #22 lists for
  app kill): switching provider tabs clears the region and drops the
  references, but there is no explicit instance-terminate API — the
  panel's engine-side resources are released by GC, not by contract.
- **Dropbox provider timings in-page**: `store-grant` (seal pickup +
  upload + mint link) ~1.5–2 s, `bucket-flush` ~1.5 s, link-tier pull
  ~2 s, revoke (revoke pickup link + delete + revoke container link +
  re-mint + rewrite remaining pickups) ~5 s — consumer-API latency, on
  the deliberately non-realtime path.

## Scope cuts (deliberate, recorded)

- **Individual membership instead of user groups** in the browser
  choreography (groups + cards + both revocation flavors are proven in
  `spikes/tasks-engine` G3; the browser demo exercises engine+UI+sync).
- **Share-at-boot**: BeeKEM adds are not retroactive, so a mid-demo
  *first* share would (correctly) show Bob a partial history — honest
  but confusing in a demo; the mid-demo trust-change beat is the
  revocation instead.
- **No G5 unlock UI**: the identity bundle + restart is proven headless
  (tasks-engine act 10); the browser leg (passkey-PRF / file picker)
  needs user-gesture ceremonies that an autonomous run can't exercise.
