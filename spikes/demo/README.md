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
| Bob | collaborator | live (n0's public relay by default) |
| Alice — tablet | second device, **zero connections ever** | your S3 bucket (Storage… dialog) |

Demo beats, all driven through the real UIs and verified:
adds/toggles/edits converge across all three replicas; the tablet cold
boots from the bucket and authors through it; **Revoke Bob** mid-demo:
alice's next task reaches the tablet (K_p republish + epoch rotation)
while bob's pane holds the ciphertext it can no longer decrypt
(`undecryptable: 1` in his status line) — cryptographic exclusion,
visible in a todo list.

## Architecture

```
per pane (×3, one browser page):
  app component (109 KB)            engine composite (10.8 MB)
  todomvc surface guest             keyhive+automerge+subduction+
  imports: dom/events/shell         bridge+SigV4+iroh endpoint
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
pane activates through the **Storage…** dialog with any S3-compatible
endpoint whose CORS admits the page origin (`just infra` runs a local
MinIO with open CORS, plus a local relay). Hosted build:
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
