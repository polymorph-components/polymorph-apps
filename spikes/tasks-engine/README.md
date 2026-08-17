# Tasks-engine spike (#20 G1 + G2 + G3)

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

## Users are groups of devices (G3, #10's minimal slice)

"Alice" and "bob" are keyhive **groups**; devices are individuals
enrolled in them. The partition is delegated to the groups (never to
devices); effective access is transitive (individual → user group →
doc), and subduction's policies resolve it transitively too
(`transitive_members`). The two demo failure stories are the same
mechanic at different nodes of the delegation graph:

- **Removed collaborator**: revoke bob's *group* from the *doc*.
- **Lost phone**: revoke the *phone* from Alice's *group* — every doc
  containing the group drops CGKA leaves for individuals no longer
  reachable.

Cross-user linking is by **card**: an agent's card carries the
memberships it can reach (bob's card = his prekeys + his group's
constitutive ops). Bob pastes his card to Alice (QR/link in the
product; the host carries it here), and it must be distributed to
*every* member instance — see findings.

## Scenario (host/src/main.rs)

Three engine instances over a real iroh relay: Alice's **laptop** and
**phone** (enrolled in her user group) and **bob**, a collaborator with
his own user group. Laptop is the wire hub.

1. Wires up (two tagged QUIC streams per connection: 'S' subduction,
   'K' keyhive bridge); contact cards travel over the bridge.
2. Groups: laptop creates Alice's group and enrolls the phone; bob
   creates his; cards are exchanged (bob's to laptop AND phone,
   Alice's to bob).
3. Partition lifecycle: create → delegate to the two groups (**edit** —
   subduction's put policy requires it) → seal; members adopt,
   first-sync, and decrypt transitively.
4. Tasks flow + the concurrency fork/merge + three-way convergence.
5. Collaborator edit propagates (transitive put authority).
6. Revocation flavor 1: bob's group revoked from the doc; **phone rides
   the rotation** (~100 ms); bob never sees the new task (and received
   none of its bytes).
7. Revocation flavor 2 (lost phone): phone revoked from Alice's group;
   laptop's next task never becomes readable at the phone (ciphertext
   arrived, decrypt refused — `undecryptable: 1`).

## Findings

- **Cards must be distributed to every member instance; the wire will
  not do it.** The bridge's reachability model offers a group's
  constitutive ops only to that group's members, in both directions of
  every pair sync. So after Alice pastes bob's card on her laptop, her
  phone can never learn bob's group over the wire — it holds a
  `doc → bob-group` delegation whose delegate never materializes. Runs
  with partially distributed cards failed intermittently (~1/3): the
  member wedged at `KeyNotFound` for the creation chunk and ~100
  phone-initiated re-sync rounds never healed it (op-arrival order
  varies run to run; whether a pending foreign-group delegation wedges
  epoch derivation permanently is an open upstream question worth a
  minimal repro). With cards distributed to all members: 8/8 green.
  Product consequence: received cards are state that must replicate to
  the user's other devices (e.g. inside a doc the devices share), not a
  one-device paste.
- **Group-card export is "events for my individual", not "events for
  the group".** `static_events_for_agent(group)` walks memberships the
  *group* can reach (upward), which excludes the group's own
  constitutive ops. Exporting for the *individual* yields the useful
  card: prekeys + every membership the person can reach. (It also
  carries every group/doc the person can reach — a privacy surface to
  scope before the product exposes it.)
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
- **Push behavior after the two revocation flavors differs, and both
  are safe.** Doc-level group revocation: the revoked member received
  *no bytes* of the next chunk (the push policy filtered him).
  Group-membership revocation: the revoked device still received the
  ciphertext but cannot decrypt it. Context for the #17 draft: the
  skeleton's "subscription bypasses the pull gate" observation is
  timing-dependent, not unconditional.
- Ordering (from the skeleton, still load-bearing): create → add
  members → **first seal**. BeeKEM adds are not retroactive. Enrolling
  a device into a group propagates CGKA adds to docs containing the
  group from the next epoch onward — same non-retroactivity,
  transitively.

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
