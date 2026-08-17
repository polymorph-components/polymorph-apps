# Tasks-engine spike (#20 G1 + G2)

The walking skeleton's content spine generalized from a linear chain to
the **real automerge change DAG**, with the first data service —
`polymorph-data:tasks@0.1.0` — served from inside the engine composite
(the demo-v1 topology). Quarantined, delete-at-will, wired into no CI.

```
tasks.add("buy milk")
  ──▶ automerge change (one mutation = one chunk; deps = the frontier)
  ──▶ keyhive encrypt under the current BeeKEM epoch
  ──▶ sedimentree commit (parents = the change's deps)
  ──▶ subduction sync over component-iroh ──▶ every member's replica
```

## One DAG across three layers

Chunk identity is the automerge `ChangeHash`; the chunk's **parents are
the change's `deps()`**, which are also the keyhive `pred_refs` bound
into the ciphertext and the sedimentree commit's parents. Authoring
merges whatever has synced (so deps capture the true frontier), commits
exactly one automerge change, seals it, commits the envelope. Reading
applies newly synced chunks in causal order (parents before children);
chunks the current epochs can't decrypt are counted and retried on later
polls.

The scenario proves the DAG is real: laptop and phone author
concurrently from the same frontier (a fork), sync, and phone's next
change merges it — `chunk-stats` reports a chunk with **two parents**,
and all three replicas converge to the same task list.

## The tasks data service

`guest/wit/deps/polymorph-data-tasks/tasks.wit` is the draft
schema-authority contract (NOTES.md, "System services"): apps bind
`tasks`, never document surfaces. v0.1 is poll-shaped (`revision` probe
+ `items` snapshot; a change-feed stream is the expected v0.2). The
spike serves it from the same component as the engine; splitting it into
its own component later is a wac refactor, not a contract change.

## Scenario (host/src/main.rs)

Three engine instances over a real iroh relay: Alice's **laptop** and
**phone** (both direct members — device = key stand-in until #11's
device tree) and **bob**, a collaborator. Laptop is the wire hub.

1. Wires up (two tagged QUIC streams per connection: 'S' subduction,
   'K' keyhive bridge); contact cards travel over the bridge.
2. Partition lifecycle: create → add members (**edit** — subduction's
   put policy requires it) → seal; members adopt and first-sync.
3. Tasks flow + the concurrency fork/merge + three-way convergence.
4. Collaborator edit propagates.
5. Revocation: bob is cut off; **phone rides the rotation** (~100 ms)
   and sees the post-revocation task; bob never does.

## Findings

- **`KeyhiveProtocol`'s event cache must be refreshed after local ops.**
  `sync_keyhive` serves each peer's event set from a
  `PeriodicEventCache` once one exists. Upstream's runtime refreshes it
  on an interval; an embedder that skips the runtime and creates ops
  locally (member changes, encrypt-time CGKA rotations) must call
  `refresh_cache()` before syncing — otherwise every op created after
  the cache first fills is silently never offered to peers. Symptom
  here: the post-revocation rotation op never reached the remaining
  member, whose decrypts failed `KeyNotFound` forever.
- **One-shot bridge syncs need a retry discipline.** The sync rounds
  are request/response with no retry; upstream drives them from a
  periodic loop. The spike nudges a refreshed re-sync from read polls
  that find themselves waiting (missing keyhive doc, undecryptable
  chunks), rate-limited to ~every 20th poll.
- **The skeleton's post-revocation push observation is
  timing-dependent.** With the cache refreshed, the revoked subscriber
  did *not* receive the post-revocation ciphertext (0 extra bytes at
  bob), unlike the skeleton run where the subscription pushed it. The
  crypto layer held in both. Relevant context for the #17 draft: the
  bypass is not unconditional.
- Ordering (from the skeleton, still load-bearing): create → add
  members → **first seal**. BeeKEM adds are not retroactive.

## Running

Needs a `polymorph-iroh` checkout with the endpoint component and relay
built (see that repo); override with `IROH_CHECKOUT=…`.

```
just run    # build guest, wac-compose with iroh endpoint, run vs local relay
just check  # clippy, both targets
```

Pins: keyhive `efe6ccf3`, subduction `2401102`, automerge 0.11.0,
wasmtime 47, wit-bindgen 0.59 (`async`, `async-spawn`,
`inter-task-wakeup`), polymorph-webcrypto `b13d2523`. The workspace
`[patch.crates-io]` unifies keyhive onto the git rev (the bridge pins
released keyhive).
