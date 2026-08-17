# Tasks-engine spike (#20 G1 + G2 + G3 + G4)

The walking skeleton's content spine generalized from a linear chain to
the **real automerge change DAG**, with the first data service —
`polymorph-data:tasks@0.1.0` — served from inside the engine composite
(the demo-v1 topology), synced over **both paths**: realtime
(component-iroh) and non-realtime (an S3-compatible bucket, the #19 pull
layer). Quarantined, delete-at-will, wired into no CI.

```
tasks.add("buy milk")
  ──▶ automerge change (one mutation = one chunk; deps = the frontier)
  ──▶ keyhive encrypt under the current BeeKEM epoch
  ──▶ sedimentree commit (parents = the change's deps)
      ├──▶ subduction sync over component-iroh ──▶ live members
      └──▶ bucket object under a per-epoch name-key ──▶ cold members
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

## The bucket path (G4, #19's pull layer under this engine)

The storage spike's stand-ins are replaced by the real coupling:

- **Chunk objects are the sedimentree blobs, byte for byte** — the
  keyhive `EncryptedContent` envelope. There is no second content
  encryption; BeeKEM is the read gate on both surfaces.
- **Object names** are `HMAC(name-key, kind ‖ id)`; the name-key
  keychain **rotates with revocations** (a `store-revoke` pushes a new
  epoch alongside the BeeKEM rotation the keyhive revocation causes).
  Old epochs keep granting history names; new objects are dark to
  holders of old keychains.
- **K_p pickup objects** bootstrap a member: the keychain + the device
  list, sealed to a DH between one of the owner's and one of the
  member's **keyhive contact-card prekeys** (both picks recorded in the
  object; the member finds its secret via
  `Active::export_prekey_secrets`). No ad-hoc x25519 material.
- **The keyhive op stream is stored as name-keyed blobs, per device**:
  everything the flusher's keyhive knows (membership + prekey + CGKA
  ops, foreign-group ops included — the G3 card lesson). This is what
  makes cold start work: a device that has never had a connection
  ingests the oplog, derives its epochs (its leaf was added at
  enrollment), and decrypts.
- **Manifests** are per-device Ed25519-signed entry lists
  `(cref, parents, epoch)` — parents let a cold puller insert chunks
  into its own sedimentree and reuse the normal causal apply path.
- Author flow: `bucket-flush` = new chunks + oplog + manifest. Boot
  flow: `bucket-pull` = K_p → oplogs → manifests → chunks → apply.
  Pulls are entirely unsigned GETs (availability by name secrecy); bob
  holds no bucket credentials at all.

## Scenario (host/src/main.rs)

Four engine instances; laptop, phone and bob over a real iroh relay
(laptop is the wire hub), plus Alice's **tablet, which never binds and
never connects** — it lives entirely off the bucket (MinIO).

1. Wires up (two tagged QUIC streams per connection: 'S' subduction,
   'K' keyhive bridge); contact cards travel over the bridge; the
   tablet's card is pasted (QR stand-in).
2. Groups: laptop creates Alice's group and enrolls phone AND tablet;
   bob creates his; cards are distributed (bob's to laptop, phone, and
   tablet; Alice's to bob).
3. Partition lifecycle: create → delegate to the two groups (**edit** —
   subduction's put policy requires it) → seal; live members adopt,
   first-sync, and decrypt transitively.
4. Tasks flow + the concurrency fork/merge + three-way convergence.
5. Collaborator edit propagates (transitive put authority).
6. Bucket: `store-grant` K_p to every member individual;
   `bucket-flush`; **the tablet cold-boots from the bucket alone** and
   its view equals laptop's live view.
7. Cold authoring: the tablet adds a task and flushes; laptop pulls;
   the task reaches phone and bob over the live wire — one DAG, both
   surfaces.
8. Revocation flavor 1: bob's group revoked from the doc AND
   `store-revoke` (K_p deleted, name-key epoch rotated). Phone rides
   the rotation live (~100 ms); the tablet rides it via K_p republish;
   bob gets no bytes live and `kp missing (404)` from the bucket.
9. Revocation flavor 2 (lost phone): phone revoked from Alice's group;
   laptop's next task never becomes readable at the phone (ciphertext
   arrived, decrypt refused); the tablet reads everything.

Final state: the wireless tablet at `iroh conns: 0` holds the complete
7-task list.

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
- **The name-key keychain is doc state, not device state.** A device
  that flushes under a privately minted keychain publishes to names
  nobody else can derive; `bucket-pull` therefore adopts the K_p
  keychain into local state before any flush. (First run failed
  exactly here: the tablet's manifest was invisible to the laptop.)
- **K_p locations are id-derived in this spike** (doc ‖ owner ‖
  member hashed), so no prekey-set agreement is needed to *find* the
  object — the payload is still prekey-wrapped, and revocation deletes
  it. The cost: members' K_p existence is probeable by anyone holding
  the public ids. Production wants a pairwise-secret location, which
  needs a stable pairwise-DH story on top of rotating prekeys — a
  #19/#10 design item.
- **wasi:http@0.3 + wit-bindgen coexistence held**: the storage spike's
  fetcher component (wit-bindgen 0.57) composed into this engine (0.59)
  alongside the iroh endpoint with `wac plug` — three runtimes, one
  composite, zero friction.

## Running

Needs a `polymorph-iroh` checkout with the endpoint component and relay
built (see that repo); override with `IROH_CHECKOUT=…`. MinIO is
fetched once into `.deps/` and run as a user process.

```
just run    # build guest+fetcher, compose, run vs local relay + MinIO
just check  # clippy, all three crates
```

Pins: keyhive `efe6ccf3`, subduction `2401102`, automerge 0.11.0,
wasmtime 47, wit-bindgen 0.59 (`async`, `async-spawn`,
`inter-task-wakeup`), polymorph-webcrypto `b13d2523`. The workspace
`[patch.crates-io]` unifies keyhive onto the git rev (the bridge pins
released keyhive).
