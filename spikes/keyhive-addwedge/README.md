# keyhive add-wedge investigation

**Question.** In `spikes/tasks-engine` a device added to a user group
*after* a document was sealed received every chunk and decrypted none —
including chunks written after it joined, and after a forced epoch
rotation. Before shipping enrollment on this stack we need to know whether
that is a keyhive defect or a defect in **our embedding** of keyhive.

This directory answers that with a **keyhive-only** repro: no subduction,
no iroh, no wasm, no automerge, no engine. Two or three `Keyhive`
instances in one process, exchanging `StaticEvent`s over a dumb in-memory
channel, with **delivery order as the independent variable** (the reported
defect was op-arrival-order dependent).

The framing throughout is defensive verification: *does a legitimately
added member obtain read access to content authored after it joined?* All
identities are freshly generated, obviously-synthetic in-memory test
identities (`MemorySigner::generate`); no key material is printed and none
is persisted.

## Verdict

**Not upstream.** At the pinned revision and at current upstream `main`,
keyhive grants the added member read access to post-add content in every
shape tested — 70/70 runs per revision, 140/140 total. The symptom is
reproducible on demand from a **delivery gap alone** (scenario f). The
defect therefore attributes to our embedding: what the engine's bridge
*offers the joiner*, not what keyhive *derives*.

The one caveat worth stating plainly: an absence of reproduction is
weaker evidence than a reproduction. Scenario (f) is what upgrades this
from "could not reproduce" to a positive attribution — it shows the exact
reported symptom (`KeyNotFound` forever, on post-add post-rotation
content, for a member who is genuinely in the group) arising with keyhive
behaving correctly and only the embedder's event delivery being stale.

## The two revisions

| target | spec | resolved commit |
| --- | --- | --- |
| `just pinned` | `rev = efe6ccf3ad67904b2f3b77385b1c754f9cd0f9d9` | `efe6ccf3` |
| `just main` | `branch = "main"` | `efe6ccf3` |

**Upstream `main` is currently the same commit as our pin** (verified with
`git ls-remote https://github.com/inkandswitch/keyhive refs/heads/main`,
and recorded in this workspace's `Cargo.lock`, which pins the `branch =
"main"` dependency to a resolved sha). So "upstream-fixed-since-pin" is
ruled out by construction: there is nothing between the pin and HEAD. The
BeeKEM ratcheting change (upstream #213) landed *before* the pin, not
after — `spikes/keyhive/README.md` already records the pin as including
it. No API adaptation was required, and the two runner crates compile
byte-identical scenario source.

The two-crate structure is kept anyway: when upstream moves, `cargo update
-p keyhive_core` re-resolves the `main` runner and the comparison runs
again with no code change.

## Scenarios

Each runs N=10 with seeds `0..9`. A seed drives: the shuffle of every
delivered event vector, the number and size of delivery batches (1–3), and
which direction of each exchange goes first. Delivery is otherwise
**adversarially generous** — the full reachable event set, three rounds,
every time — so no green here can be explained by a lucky sync.

| id | scenario | property asserted |
| --- | --- | --- |
| a | CORE | doc sealed, member added to the group at `Admin`, `force_pcs_update`, founder writes → **the joiner decrypts the post-rotation chunk**. All ops delivered at the end. |
| a2 | CORE, incremental | same, but with an op exchange after *every* step — the arrival order the engine actually produces, since `refreshed_sync` runs inside `create_user_group` / `add_to_group` / `rotate_docs_for_group`. |
| b | CONTROL | member added *before* the first seal → readable. Guards the harness; a failure here exits non-zero. |
| c | DIRECTION | the added-after-seal joiner encrypts; the founder decrypts. The engine's finding was directional. |
| d | PENDING delegation | three instances: the doc is also delegated to a *stranger's* group whose constitutive ops the joiner never receives — a delegation whose delegate never materializes. Probes the G3 open question (NOTES.md §Provisional plan). |
| e | MULTI-DEVICE | an existing second member authors before the add, so the epoch current at add time was minted by a device **other than the adder** — the engine's real topology. Also asserts the existing member does not lose access. |
| f | NEGATIVE control | the founder's event set is snapshotted *before* the add and rotation and never refreshed. **PASS here means the reported symptom was reproduced**, with keyhive correct. |

Every scenario runs twice, under both ways of materializing the joiner on
the adder:

- **direct** — `expand_prekeys()` + `register_individual()` (the path
  keyhive's own tests use);
- **card** — `contact_card()` / `receive_contact_card()` (the path the
  engine uses, and the one the G3 wedge was suspected to key on).

Pre-add chunks are **expected** to be unreadable (BeeKEM adds are not
retroactive — design, not defect). Scenarios (a) and (a2) record the
pre-add attempt as context and assert only the post-add chunk. In every
run the pre-add attempt failed with `KeyNotFound`, i.e. non-retroactivity
held exactly as designed.

## Results

Reproduce with `just both` (writes `results-pinned.txt`,
`results-main.txt`, which carry the per-seed detail lines).

### keyhive `efe6ccf3` (pinned) — N=10 per scenario

| scenario | pass | fail |
| --- | --- | --- |
| a CORE post-add readability (direct) | 10 | 0 |
| a2 CORE incremental delivery (direct) | 10 | 0 |
| b CONTROL member before seal (direct) | 10 | 0 |
| c DIRECTION joiner writes (direct) | 10 | 0 |
| d PENDING foreign-group delegation (direct) | 10 | 0 |
| e MULTI-DEVICE existing member authored (direct) | 10 | 0 |
| f NEGATIVE stale event set (pass = symptom reproduced) (direct) | 10 | 0 |
| a CORE post-add readability (card) | 10 | 0 |
| a2 CORE incremental delivery (card) | 10 | 0 |
| b CONTROL member before seal (card) | 10 | 0 |
| c DIRECTION joiner writes (card) | 10 | 0 |
| d PENDING foreign-group delegation (card) | 10 | 0 |
| e MULTI-DEVICE existing member authored (card) | 10 | 0 |
| f NEGATIVE stale event set (pass = symptom reproduced) (card) | 10 | 0 |

### keyhive `branch main` (resolved `efe6ccf3`) — N=10 per scenario

Identical, scenario for scenario:

| scenario | pass | fail |
| --- | --- | --- |
| a CORE post-add readability (direct) | 10 | 0 |
| a2 CORE incremental delivery (direct) | 10 | 0 |
| b CONTROL member before seal (direct) | 10 | 0 |
| c DIRECTION joiner writes (direct) | 10 | 0 |
| d PENDING foreign-group delegation (direct) | 10 | 0 |
| e MULTI-DEVICE existing member authored (direct) | 10 | 0 |
| f NEGATIVE stale event set (pass = symptom reproduced) (direct) | 10 | 0 |
| a CORE post-add readability (card) | 10 | 0 |
| a2 CORE incremental delivery (card) | 10 | 0 |
| b CONTROL member before seal (card) | 10 | 0 |
| c DIRECTION joiner writes (card) | 10 | 0 |
| d PENDING foreign-group delegation (card) | 10 | 0 |
| e MULTI-DEVICE existing member authored (card) | 10 | 0 |
| f NEGATIVE stale event set (pass = symptom reproduced) (card) | 10 | 0 |

Also observed, in every run of (a)–(e): `stuck-events=0`. Nothing the
joiner received was left un-ingestible, so the joiner's op set was
*complete*, not merely large.

### What this rules out

- **Op-arrival order.** 140 randomized interleavings, zero failures. The
  ~1/3 intermittency reported for the engine is not a property of
  keyhive's ingestion under a complete event set.
- **The card path.** `card` and `direct` materialization behave
  identically. The defect does not key on contact-card ingestion.
- **The pending foreign-group delegation** (the G3 open question). A
  joiner holding a delegation to a group it can never resolve still
  derives its epoch and reads (scenario d, 20/20). This does **not**
  say the G3 wedge was imaginary — it says the wedge is not *this*
  mechanism inside keyhive, and belongs to the same delivery/reachability
  question as everything else here.
- **Non-retroactivity as a misdiagnosis.** The post-add chunk is written
  after a forced rotation and is readable; only pre-add content is dark,
  which is the designed behaviour.

### What it points at instead

The engine's joiner does not receive `static_events_for_agent` directly —
it receives whatever subduction's `KeyhiveProtocol` chooses to offer,
served from a `PeriodicEventCache`. The tasks-engine README already
records that this cache must be refreshed after local ops or "every op
created after the cache first fills is silently never offered to peers",
with the symptom "decrypts failed `KeyNotFound` forever". Scenario (f) is
that failure mode, isolated: it is sufficient to produce the entire
reported picture, including the directional asymmetry (the joiner can
author because *its own* CGKA state is fine; it cannot read because the
adder's post-add ops never arrived).

Next step for #36, outside this spike's territory: instrument the engine
to compare, at the joiner, the ops it actually holds against
`static_events_for_agent` computed on the founder at the same instant. If
the sets differ, the attribution is confirmed at the byte level and the
enrollment doc-regeneration workaround (PAIRING.md §2) can be re-evaluated
rather than kept permanently.

## Existing-report sweep (read-only)

`gh issue list -R inkandswitch/keyhive --state all` (25 issues total) and
`gh pr list --state all`. Nothing filed, nothing commented, nothing
reacted to.

**Nothing upstream reports this class as a keyhive defect.** The four
adjacent items:

- **#206 (OPEN) — "eventsForAgent & allEvents don't group membership info
  relating to other agents."** The closest match, and it is an
  *event-set-completeness* report, not a BeeKEM one: peer A → peer B
  directly works; the same access routed **through a relay** leaves B
  unable to decrypt and showing undefined access, because the relayed
  event set omits membership/existence of other agents in B's groups.
  This is independently the same lesson as our own G3 card finding ("cards
  must be distributed to every member instance; the wire will not do it"),
  and it is directly relevant to the engine, where the laptop is the wire
  hub and other devices are served relayed state.
- **#136 (OPEN) — "Initial commits from document creation are not synced
  upon delegating document access."** A peer given access after creation
  sees the doc head but logs `Decrypt(KeyNotFound)` for the initial
  commit. Same error, but scoped to the *creation* commit — i.e. pre-add
  content, which is the non-retroactive case we expect to fail. Not our
  defect, but worth knowing it is a live upstream thread with the same
  error string.
- **#137 (OPEN) — "Group membership error/loop scenario."** Removal, not
  addition; sync loop/error rather than a readability wedge.
- **PR #216 (OPEN, filed 2026-08-18) — "Fixes for CGKA access."** Live
  work on transitive authority and CGKA-tree membership, with "a suite of
  tests that fail on `main` and pass with these fixes". Its changes
  *tighten* access (weakest-link on the best path; `Relay` access must not
  transitively grant CGKA membership), so it is not a fix for our
  under-granting symptom — but it is the area moving, and re-running
  `just main` after it merges is cheap insurance.

Also relevant as evidence *against* an upstream defect: PR #199 (MERGED),
"Add test for encryption/decryption through transitive access" — upstream
carries its own passing test for the transitive individual → group → doc
read path this investigation exercises.

## Draft issue

`UPSTREAM-ISSUE.md` — **not filed, and not currently fileable as a bug
report**, since this investigation found no upstream defect. It is written
as the question that *is* still worth asking upstream, with the repro
attached. Filing is a human decision.

## Layout

```
Cargo.toml            workspace: two runners, one scenario source
scenarios/scenarios.rs  the whole harness (shared via #[path])
pinned/               runner against rev efe6ccf3
main/                 runner against branch main
justfile              pinned / main / both / check
```

Quarantined, delete-at-will, wired into no CI.
