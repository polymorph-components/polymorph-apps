# DRAFT — not filed

**Status: do not file as a bug report.** This draft was prepared as part
of an investigation that set out to attribute a post-add readability
defect to keyhive. It did not find one: keyhive behaved correctly in all
140 measured runs, across two revisions and six scenario shapes. Filing
the text below as "[Bug]" would be wrong.

What remains worth asking upstream is a **question about intended
guarantees**, plus an offer of the repro harness. Kept here so the human
who decides can file, adapt, or discard it. Nothing has been filed,
commented, or reacted to on `inkandswitch/keyhive`.

---

## Draft: question — what is the intended completeness guarantee of the
## event set an embedder must deliver for post-add read access?

### Context

We embed `keyhive_core` (rev `efe6ccf3`) behind our own WIT surface, with
op sync driven by subduction rather than by keyhive's own runtime. Our
device-enrollment path is: a user is a **group**, devices are individuals
in it, documents are delegated to the group at `Edit`, and a new device is
added to the group at `Admin` after documents already exist and have been
sealed.

We observed newly added devices never becoming readers of those documents
— not for pre-add content (expected: adds are not retroactive) and not for
content authored *after* the add and after a forced `force_pcs_update`
(not expected). The error was `KeyNotFound` on every chunk, persistently.

### What we verified first

We wrote a keyhive-only harness — no sync layer, no application layer, two
or three `Keyhive` instances exchanging `StaticEvent`s in-process over a
dumb channel, with delivery order randomized per seed — and **could not
reproduce the defect**. Verified at rev `efe6ccf3` and at `main`
(currently the same commit):

| scenario | result |
| --- | --- |
| doc sealed → member added to group at `Admin` → `force_pcs_update` → founder writes → member decrypts | 10/10 pass |
| same, with an op exchange after every step | 10/10 pass |
| control: member added before the first seal | 10/10 pass |
| reverse direction: the added member writes, the founder reads | 10/10 pass |
| the doc is also delegated to a group whose constitutive ops the added member never receives | 10/10 pass |
| an existing second member minted the pre-add epoch, not the adder | 10/10 pass |

(Each ×2, for members materialized via `contact_card` /
`receive_contact_card` and via `expand_prekeys` /
`register_individual` — identical results. Test identities are freshly
generated in-memory `MemorySigner`s; nothing here involves real key
material.)

We then reproduced our own symptom deliberately: snapshot
`static_events_for_agent` for the joiner **before** the add and the
rotation, deliver only that, never refresh — `KeyNotFound` forever, 10/10,
with keyhive behaving correctly. That is almost certainly our bug: our
sync layer serves peers from a cache we were not refreshing after locally
created ops.

### The question

Is there a documented (or intended) statement of **what an embedder must
deliver, and when**, for a newly added member to derive a usable epoch?

Concretely:

1. Is `static_events_for_agent(added_member_agent)`, recomputed *after*
   the add and any subsequent CGKA operations, the complete and sufficient
   set? Our results say yes for the shapes above, but we would rather
   depend on a stated contract than on six passing scenarios.
2. Is there any op an embedder is expected to route **outside** that set —
   e.g. the `update_op` returned by `try_encrypt_content`, or the op from
   `force_pcs_update`? Both appear to be reachable through the normal
   event set in our tests; a note either way would remove a whole class of
   embedder error.
3. Is a partial/stale event set expected to be *recoverable* on a later
   complete delivery, or can it wedge? In our harness recovery was always
   complete once the fresh set arrived (`stuck` events were always 0), and
   we would like to be able to rely on that: it is the difference between
   "a missed refresh degrades sync" and "a missed refresh permanently
   wedges a device".

### Related existing reports

This looks adjacent to #206 (event sets not carrying membership
information about other agents in a peer's groups, which breaks the
relayed case while the direct case works) — we hit that independently at
the application layer and had to distribute contact cards to every device
of a user by hand. A stated completeness contract would cover both.

### Repro

The harness is small and standalone (one file, two runner crates, one
`just` target per revision). Happy to attach or upstream it as an example
if useful.
