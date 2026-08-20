# Tasks-engine spike (#20 G1 + G2 + G3 + G4 + G5)

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
10. Restart (G5): laptop exports its identity bundle (passphrase +
    PRF-shaped keyslots); a fresh instance restores from the bundle +
    bucket alone, reads everything, and authors a task the tablet
    accepts.

Final state: the wireless tablet at `iroh conns: 0` holds the complete
8-task list, one task authored by a restarted device.

## The identity bundle (G5, #11's persistence slice)

Restarts collapse to one artifact: everything *content* rehydrates from
the bucket (G4), so the only state a device must keep is its identity —
and that ships as one **sealed bundle** (keyhive archive + identity key
+ partition refs) under a random bundle key held in **keyslots**,
LUKS-style:

- a **passphrase slot** (argon2id; parameters + salt travel in the
  slot) — the wrap for a *downloadable device file* in user custody;
- a **raw-secret slot** — the passkey-PRF output or a generated
  recovery code, depending on what the host wires in.

The exposure rule is structural: wrap strength must match ciphertext
exposure. Bucket-replicated copies would omit the passphrase slot
(high-entropy only); the user's downloaded file may carry it
(have + know). Adding/removing an unlock method edits slots without
re-encrypting the payload.

The scenario proves the full loop: export with both slots → a fresh
instance refuses a wrong passphrase, restores via the right one
(identity id identical), rehydrates the whole task list from the
bucket, **authors a new task that other members accept** (the
group-encryption leaf secrets survived the archive), and a third
instance opens the same bundle via the PRF-shaped slot.

Findings for #11: the webcrypto interface has **no private-key export
at this rev** (extractability is recorded mint-time policy awaiting the
platform keystore) — so the exportable identity is an explicit
demo-grade `Soft` key variant, selected at `init`, and the honest
browser path is the keystore slice. And **self-rotation secrets live
only in the archive**: a stale bundle predating the device's own
authoring cannot reach epochs its own rotations created — refresh the
persisted bundle after authoring, or design a re-join path.

## Device pairing + the user-system partition (#10 G6, #36)

`PAIRING.md` is the pinned contract; the engine implements §1–§4 and the
headless acts in §6 run under `just pair` (relay only — no bucket is
involved, so no MinIO). Fifteen acts, including
full-history-by-walk (10 order-varied seeds) and a partitioned-writer act
that guards the merge properties the retired design could not offer.

The ceremony is interactive on BOTH devices: the new device displays a
79-character `BASE32_NOPAD_VISUAL` code (version ‖ endpoint-id ‖ token),
the trusted device consumes it, and one bidi stream on a pairing-only
ALPN carries length-framed bincode. Two properties carry it:

- **Commitment ordering.** The adder commits to its nonce before the
  joiner reveals one, so it cannot search the transcript for a chosen
  short authentication string. The joiner verifies on REVEAL.
- **Reject-on-unknown.** Every step has exactly one legal next message;
  an unknown kind, an undecodable frame, an out-of-order message, or a
  peer that closes the stream ends the session.

Plus single-claim (a second claim refuses with a distinct error and
BURNS the offer — a code that reached a second party has leaked) and a
120 s expiry. Enrollment writes in a pinned order: group membership at
**admin** first, then the card export, so the delegation rides the card.

The user-system doc backs `profile`/`marks`/`contacts`/`devices` behind a
WIT surface that hides the partitioning — including which document holds
them, so the storage shape is free to change without the visor knowing (the
retired generation design leaned on this; see §4b). Petname (case-insensitive) and
hue uniqueness are repaired deterministically after every remote apply —
older `created-at` wins, ties broken by lexicographic provenance — and
every device computes the same outcome, so only the device whose OWN
write lost persists it. `needs-reconfirm` is derived rather than stored,
which removes the write entirely on that path. `us-events` drains
remotely-caused changes only; local writes update the diff baseline as
they are made, so a device can never be announced its own work.

### The Envelope content format (§4b) — implementation note

The content spine seals a keyhive `Envelope` instead of raw chunk bytes,
at one seal site and one open site. Everything above and below carries
opaque bytes either way: WIT, the visor, subduction, sedimentree and the
bucket path are untouched.

**API actually used** (keyhive `efe6ccf3`, which is also upstream HEAD):

- `keyhive_core::crypto::envelope::Envelope<C, T>` — public fields
  `plaintext: T` and `ancestors: HashMap<C, SymmetricKey>`. There is **no
  envelope-aware encrypt API** at this rev: the embedder serializes the
  Envelope with bincode and passes the bytes to `try_encrypt_content`,
  which is exactly the shape the read side expects, since
  `try_causal_decrypt` does `bincode::deserialize::<Envelope<Cr, T>>` on
  each plaintext it opens. We use `Envelope<[u8; 32], Vec<u8>>`.
- **Where ancestor keys come from**: `try_encrypt_content_keyed` returns
  the `SymmetricKey` it minted for the chunk, and
  `try_decrypt_content_keyed` returns the key a chunk was opened under; a
  walk additionally returns `CausalDecryptionState::keys`. The engine
  keeps a `cref -> SymmetricKey` map fed from all three. The write-path
  invariant is that those are the ONLY ways a chunk becomes an automerge
  dependency — you can only author on top of what you materialized — so a
  writer can always name its parents' keys. Sealing refuses rather than
  silently omitting a parent, since an omission would cut the chain for
  every later reader.
- **Walk mechanics**: `Keyhive::try_causal_decrypt_content(doc,
  entrypoint)` decrypts the entrypoint, reads its ancestors' keys out of
  the plaintext, and recurses through the **ciphertext store**, returning
  `complete: Vec<(cref, inner-plaintext)>`. Two consequences for an
  embedder: the store must be populated (ours lives in the sedimentree,
  so received ciphertexts are inserted into keyhive's store on demand —
  a clone of the store handed to `Keyhive::generate` shares its state),
  and keyhive **evicts** what it has decrypted (`mark_decrypted` removes),
  so the store is a working set refilled from the sedimentree rather than
  a durable copy. Only chunks this device can open DIRECTLY are valid
  entrypoints; one recovered by a walk cannot start another.
- **Ordering**: the walk needs an entrypoint, so a device with no
  readable chunk yet simply counts the rest as unreachable and retries on
  the next poll. Enrollment removes the race by construction — the
  devices-entry write is sealed under a post-add epoch, so the joiner is
  guaranteed a directly-openable chunk (the walk anchor, §2).

**What this replaced.** Enrollment used to regenerate the user-system doc
and copy state values across, with a forward pointer, value
reconciliation and generation-fork detection. All of it is deleted. The
partitioned-writer gate is the reason it is safe to delete: with one
document lineage a concurrent add, rename and *forget* all merge as
ordinary CRDT changes, where the value-copy design could resurrect a
forgotten mark and lose a rename. The retired design and its measurements
live in git history (PR #40) and in the finding below.

**Security note, carried from NOTES and restated because it is easy to
lose in an implementation detail**: possession of one chunk key
transitively grants everything behind it, so the read-back window is a
policy decision, not a property of the format. It is deliberately TOTAL
here — the user's own devices — and the chain-cut policy for shared
partitions (what a newly added collaborator may walk; compaction
boundaries are the natural cut points) is a #36/#9 decision-memo item,
recorded and not solved. Keyhive's content-envelope scheme is
CAUTION-flagged in upstream's own design doc, and independent review
gates any polymorph data shipping under it. **This spike implements it;
it does not ship it.** The plaintext layout change is a format generation
bump; the spike carries no deployed data, so no migration exists here
(#8's seam).

### Finding: post-seal enrollment was never broken — the gate was measuring the wrong thing

This section previously reported that a device added to the user group
*after* a document was sealed could never read that document, and blamed
the pinned keyhive revision. **That attribution was wrong, and so was the
framing.** `spikes/keyhive-addwedge` settled the upstream half — 140/140
green across every legitimate shape, at the pin and at upstream `main`
(which is the same commit) — and the engine-side measurement below
settles the rest.

**What is actually true.** A late-joining device decrypts post-join
content correctly. What it cannot do is *materialize* that content,
because the automerge dependency chain of every post-join change roots in
changes written before it joined, and automerge buffers changes whose
dependencies are missing rather than erroring. The old gate asserted
materialization (`us-profile-get` returning the name, a mark appearing in
`us-marks-list`), so a joiner that was opening envelopes perfectly still
presented as reading nothing at all. The `[decrypt] KeyNotFound` output
was the pre-join chunks, which is designed non-retroactivity.

The engine now measures the two separately: `stats` reports
`us-decrypted` (envelopes opened) alongside `us-undecryptable` and
`us-revision` (automerge state materialized). With that distinction
visible, the picture is unambiguous.

**Measurements** (act: post-seal add on the original doc, regeneration
disabled — `just pair`, 10/10):

- the late joiner opens the chunk the founder writes after the add;
- it opens that chunk with the forced epoch rotation **switched off**
  (`PM_NO_ROTATE`) — so the rotation is defence in depth, not the
  mechanism: keyhive's `add_member` already propagates the CGKA add to
  every doc transitively containing the group;
- it opens that chunk with the hand-delivered ENROLL card **suppressed**
  (`PM_SKIP_ENROLL_CARD`) — so the subduction/keyhive bridge does deliver
  the joiner's event set; enrollment does not depend on the out-of-band
  card;
- pre-join content stays dark in all configurations, which is design.

On the founder, the bridge computes 18 events reachable to the joiner and
18 to itself, so the per-peer reachability the cache serves from is
correct.

**One measurement I could not resolve**, recorded rather than smoothed
over: re-ingesting the founder's authoritative card late in the act
reports every event in it as new to the joiner (`delegations+4
prekeys-expanded+7 prekey-rotations+2 cgka-operations+5`), which sits
badly with the joiner demonstrably having synced. The likeliest
explanations are that the card at that instant contains ops created after
the joiner's last sync round, or that keyhive's op counters are not
idempotent across a duplicate ingest. It is no longer load-bearing for the
attribution — the card-suppressed run settles delivery directly — but it
is not explained, and anyone extending this should not treat that counter
as a set difference.

**A methodological note worth keeping.** An earlier version of this
instrumentation hashed locally-reconstructed `StaticEvent`s and diffed the
digests. Those digests are not stable across two instances' constructions,
so it reported "everything missing" for an instance that provably held the
ops — a measurement that looked like strong evidence and was noise. The
current instrument counts through keyhive's own accounting instead. The
original error this whole section corrects was of the same family:
comparing op *counts* and reading equality as set equality.

**What remains true by design**, and is now asserted as such rather than
mistaken for a defect:

- **Non-retroactivity.** BeeKEM adds are not retroactive; pre-join
  ciphertext stays dark. The new act asserts this as EXPECTED-unreadable
  so the boundary is documented, not folded into a pass.
- **Causal read-back needs the Envelope content format.**
  `try_causal_decrypt_content` expects plaintext to be an `Envelope`
  carrying ancestor keys, while `try_encrypt_content` — what this spike
  uses — encrypts raw content. That is the production path for late
  joiners reading history (#36), not a bug.
- **Regeneration is retired.** It was the interim state-handoff while a
  late joiner could not materialize pre-join history. The Envelope format
  (above) replaces it with causal read-back, so the doc has one lineage
  again and the copy-shaped hazards go with it. Engine-driven
  subscriptions and the diff baseline survive; the forward pointer,
  value reconciliation and fork detection are deleted.

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
