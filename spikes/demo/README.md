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

The #22 provisional ruling says chrome is trusted shell code, with one
named exception: *"third-party chrome-ish things (a storage backend's
config panel) are **apps** — own sandboxed region, own grants, launched
from chrome, never rendered as chrome."* This demo implements exactly
that, and it is the first place the framework's capability story is
visible in UI:

```
chrome (page JS, trusted)          panel component (sandboxed, per-provider)
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
- **Chrome brokers OAuth.** Navigation, popups and redirect handling are
  chrome capabilities a sandboxed panel must not have, so the Dropbox
  panel calls `oauth-broker.authorize(app-key)` and chrome runs the
  whole PKCE ceremony (S256 challenge, popup, `postMessage` relay
  through the redirect, code exchange) and returns only the tokens. The
  panel never sees the ceremony; the app guests never see any of it.
- The panel's `fetch` import **is** the per-destination network grant:
  chrome's shim refuses any host but `api.dropboxapi.com` with a WIT err
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
  fetch-backed wasi:http fragment) + sibling deltic ports
  (webcrypto / websocket [vendored, migrated] / webrtc) + sockets stub
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

Requires sibling checkouts
(`polymorph-iroh` built, `polymorph-{webcrypto,websocket,webrtc-datachannels}`)
and the `spikes/tasks-engine` MinIO fetch (run that spike once).

Headless bring-up phases (`just bringup solo|wire|bucket`) retire the
platform layers one at a time under Deno; `wire soak` runs a 30 s
post-revocation stress loop.

## Findings

- **deltic 0.1.0 renamed the embedder conventions** (`WitError` →
  `ComponentException`; variant envelopes `{tag, val}` → `{kind,
  value}`). The sibling port modules still pin the pre-release embedder
  through their own `deno.json` — a silent module-identity violation
  when consumed from a 0.1.0 graph: values from the old module meet the
  new runtime's strict lowering. The websocket port is **vendored here
  with a mechanical migration** (`host/ports/websocket.ts`); webcrypto
  and webrtc happen to be shape-compatible on the engine's paths.
  Upstream migration of all three ports retires the vendored copy.
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
  (stats stand down). Worth carrying into the framework's chrome: a
  status surface that mixes ambient telemetry with consequential
  one-shot messages needs priority, not last-writer-wins.
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
