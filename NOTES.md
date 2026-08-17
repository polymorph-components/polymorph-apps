# polymorph-apps design notes

Consolidated from the founding design discussion (2026-08-16).

**Status: nothing in this document is finally decided.** It records the
design sketch, the analysis, and the current leanings that the tracking
issues start from. Open questions live in the issue tracker, not here;
when a topic is resolved, the ruling and its rationale land in this
document (or a dedicated doc it links) and the issue closes. Sections
marked **provisional plan** sit between leaning and ruling: adopted as
the working plan, converted only by their named checkpoints. There are
no per-surface `@unstable` gates: **the entire framework is unstable
until declared otherwise**, so a stability annotation would state
nothing — a gate that does not bind produces the wart without buying
the compatibility.

## What this is

A framework for building PWAs that inverts the standard web application
architecture: applications run client-side under user-controlled
capability confinement — a permissions model in the spirit of modern
mobile OSes, but cross-platform because the "OS" is a set of browser
primitives the framework composes.

The moving parts, as sketched:

- The user selects a **home origin**, trusted to faithfully serve the
  framework as static content and to act as an isolated browser origin.
- **Applications are WebAssembly component-model components.** The
  framework instantiates them against designed host interfaces; what an
  application can reach — network, user data, peers — is exactly what
  the user granted.
- **Application UI is embedded in the component** and rendered in a
  sandboxed iframe (srcdoc/blob-style documents, minimal sandbox
  flags), talking to the framework over postMessage RPC. All external
  interaction goes through managed RPC; the UI frame itself has no
  direct network.
- The framework provides **data services**: realtime synchronization
  (component-iroh + automerge), durable backup and non-realtime sync
  (pluggable storage backends), and fine-grained application access
  control under user consent.
- **Peer-to-peer interaction** between users is mediated by the
  framework: a common contact list, data sharing, and realtime
  collaboration (iroh + automerge again), end-to-end encrypted.
  Multi-device sync for one user plausibly unifies with multi-user
  sharing by modeling a user's devices as identities in a permissive
  group.

### Why components

The wasm component layer is an expensive bet; what it buys, explicitly:

1. **Capability enforcement by construction.** Permissions are the
   linker: an application's imports are satisfied, stubbed, or left
   unlinked according to grants. There is no ambient authority to
   confiscate — the interface *is* the sandbox (see
   [Permission model](#permission-model)).
2. **The same application logic runs headless** — on the user's other
   devices, an always-on personal node, or (consciously; see
   [Compute placement and push](#compute-placement-and-push)) a
   provider. Background execution is the classic PWA weakness;
   component-iroh's deployment matrix (browser / native / in-guest)
   exists for exactly this.
3. **Language-agnostic applications** with typed, versioned interfaces
   (WIT) instead of an ad-hoc JS API.
4. **Merge and agent logic stays portable and confined** — app-supplied
   code that must run where the data is can be run without trusting it.

The cost is developer experience; that is a first-class topic
([Developer experience](#developer-experience)), because porting
friction is what killed the closest prior system (Sandstorm).

## The substrate

The polymorph family already de-risks the bottom of the stack:

- [deltic](https://github.com/lann/deltic) runs components
  runtime-linked on stock browsers and Deno — no transpile step, no
  engine flags.
- [component-iroh](https://github.com/polymorph-components/polymorph-iroh)
  gives browser peers real end-to-end QUIC over WebRTC data channels,
  relays, and UDP, with one Ed25519 endpoint identity across all paths,
  interoperable with upstream iroh.
- [polymorph:webcrypto](https://github.com/polymorph-components/polymorph-webcrypto)
  holds identity keys as non-extractable platform handles behind
  capability-shaped WIT (keys are resources; minting is separate from
  use).
- [polymorph:tls](https://github.com/polymorph-components/polymorph-tls)
  carries in-guest crypto under a wasm timing-class policy.
- [polymorph:test](https://github.com/polymorph-components/polymorph-test)
  is the cross-implementation conformance machinery.

The framework layer is the part that does not exist yet: the shell, the
linker-as-permission-system, the data services, and the consent UX.
Most of its hard problems are web-platform trust problems and
group-crypto problems, not wasm problems.

## Trust model

Proposed organizing invariant:

> **Nothing in the system is both live and trusted.**
> Trusted ⇒ static (the home origin's content, release artifacts).
> Live ⇒ untrusted by construction (relay, push service, storage
> backends, peers), covered by end-to-end crypto and capability
> confinement.

The invariant is checkable and forces the right question every time a
feature wants a server: *can this be static, or can it be untrusted?*
If neither, the feature changes shape.

The home origin is **completely trusted** — it ships the code that
holds every key — but it is only required to faithfully serve static
content. Two statements, both true, kept distinct:

1. Static-only makes the origin much *harder to compromise*: no request
   handlers, no injection surface, no sessions, no database, no
   per-user code paths.
2. Static-only does *not reduce the damage* of a compromise. Exposure
   is total either way.

The design buys (1) and accepts (2) consciously.

Residual attack surface of a static origin: the DNS/registrar account,
TLS issuance (CAA records and CT-log monitoring are the cheap
mitigations; key pinning is dead in browsers), CDN/cache poisoning, and
— realistically the largest — the framework's own release/build
pipeline. Static-only has one structural consolation: every user is
supposed to receive byte-identical releases, so third-party monitoring
("does this origin serve the published hashes?") is meaningful in a way
it never is for a dynamic origin. Caveat: per-user subdomains weaken
naive canary monitoring — a compromised wildcard origin can serve clean
bytes to `canary.host` and different bytes to `alice.host`.

Client-side TCB: the framework release, the browser, the OS.

Candidate explicit non-goals (to be confirmed in the threat-model doc):
metadata privacy (relays, push services, and the origin see traffic
timing and contact-graph shape), browser/OS compromise, covert channels
between colluding same-browser code.

## Home origin contract

"Static" is not just bytes; the load-bearing fine print:

- **Headers are security configuration, not content.** CSP must arrive
  as headers (the app-frame story depends on header-CSP inheritance;
  meta CSP cannot express `frame-ancestors`/`sandbox`/reporting and has
  parse-order caveats), plus COOP/COEP if `crossOriginIsolated` is ever
  needed (wasm threads / SharedArrayBuffer), `Permissions-Policy`,
  HSTS, `X-Content-Type-Options`, correct `application/wasm` MIME for
  streaming compilation, CORP on assets fetched cross-origin (the
  sandbox origin pulls from the framework origin).
- The **service worker** is a static file, but its scope and update
  behavior are part of the contract.
- The real hosting requirement is therefore "static host **with header
  control**" — naive S3/GitHub-Pages setups do not qualify unmodified.

Natural artifact: an **origin conformance checker** — a page/CLI that
probes a candidate home origin and passes/fails it against the pinned
contract (headers, MIME, SW scope, subdomain/PSL posture). Self-hosters
get a gate instead of a footgun list.

Static-only dividends worth actively exploiting:

- **Accountless multi-tenancy.** If every subdomain serves identical
  framework bytes and all state is client-side/E2E, "signing up" at a
  hosted provider is a purely client-side act. The only dynamic control
  plane a multi-tenant host needs is wildcard DNS plus a wildcard cert.
  Squatting is moot when the server holds no identity.
- **Static share-link viewing for non-users**: a reader page plus
  ciphertext from a storage backend plus the key in the URL fragment.
- **Push without a server** (see
  [Compute placement and push](#compute-placement-and-push)).

## Release integrity

Positioned as supply-chain hygiene and publisher/host separation — not
as the trust-model foundation (the origin is trusted; see above).

The cheap discipline: the **bootloader shape**. Nearly everything
content-addressed and immutable (hash-named assets,
`Cache-Control: immutable`); a single tiny mutable root (entry HTML +
SW registration) that changes only on release. Optionally the root
verifies a signed release manifest before activating cached assets.
The verification is circular — the verifier arrives from the same
origin — which is acceptable under the trust statement; the discipline
still pays because the *practical* attack surface becomes a ~2KB
diffable, monitorable bootstrap.

Signed releases additionally separate the **framework publisher** from
the **origin operator**: users trust the project, then pick any host.
Detection (not prevention) options that stack on top, roughly in order
of cost: CT-log monitoring of origin certs; third-party monitors
fetching origins and comparing to published release hashes; peers
gossiping release hashes over iroh (targeted delivery becomes
detectable by cross-checking with contacts); an optional verification
extension (the Code Verify precedent). Isolated Web Apps (Chromium
signed web bundles) are the real install-time fix but sacrifice
cross-platform PWA delivery — a possible future tier, not the baseline.

## Origin topology

Under the static-only model there is no server-side tenant state, so
per-user subdomains are about **client-side** isolation:

- On a shared browser/machine, each user's device keys and grants live
  in a different origin's IndexedDB/OPFS — a sandbox escape or
  framework bug in one user's session has a bounded blast radius.
  Quota separation comes along for free.
- A dedicated **app-sandbox origin** (serving the iframe skeleton with
  its own headers) is wanted regardless of per-user subdomains — see
  [App-frame sandboxing](#app-frame-sandboxing).

Mechanism note: browser process isolation is per **site** (eTLD+1), not
per origin — subdomains of one registrable domain may share a process
(`Origin-Agent-Cluster` is only a hint), and siblings can set
`Domain=`-wide cookies at each other. **Listing the parent domain on
the Public Suffix List fixes both**: each subdomain becomes its own
site (real site isolation, no cross-subdomain cookies, separate
storage-partitioning treatment; the github.io model). Costs: a PSL PR,
propagation lag, effective irreversibility, wildcard DNS + wildcard
cert (fine with ACME DNS-01).

Browser storage is origin-rooted, so **origin migration = device
re-enrollment**: new origin, empty storage, and non-extractable device
keys do not move — by design. That is acceptable iff
enrollment-from-another-device is a polished, cheap ceremony (wanted
anyway; see [Identity and devices](#identity-and-devices)). Identity
must not be made origin-portable by making device keys extractable.

## App-frame sandboxing

Mechanics:

- `srcdoc`/`blob:` documents **inherit the embedder's header CSP** —
  stronger than any meta-tag policy. But the shell needs `connect-src`
  (home origin, relays) that app UI must not have, and the iframe `csp`
  embedded-enforcement attribute is Chromium-only. The clean shape is
  the **dedicated sandbox origin**: the app-frame skeleton served as a
  real document with its own `default-src 'none'`-class headers.
  Opaque-origin `srcdoc` frames remain a viable alternative (app UI
  needs no storage — all state flows over RPC); real-origin vs
  opaque-origin frames is an open decision with API-availability
  consequences.
- The app UI frame gets **zero direct network**; assets arrive via
  RPC/blob injection from the component's embedded bundle.
- App logic runs in workers on the framework side (deltic,
  runtime-linked); UI ↔ shell ↔ component is a two-hop RPC path,
  acceptable for UI latencies.

Residual channels, each needing a recorded ruling (allow/block/why) in
a **ruling table per sandbox flag and CSP directive** — the same
discipline as webcrypto's WPT-deviation registry:

- WebRTC: a sandboxed frame can open a data channel with no permission
  prompt; CSP3's `webrtc 'block'` covers it where supported (Safari
  support to verify).
- Speculation rules / prefetch / DNS prefetch; anchor `ping`;
  downloads (`allow-downloads` withheld); popups / top-navigation /
  form submission (sandbox flags withheld); fullscreen / pointer lock
  (withheld); favicon and other UA-initiated fetches.
- Covert timing/contention channels between colluding code: candidate
  explicit non-goal, stated rather than discovered.

Anti-spoofing: consent UI renders in framework chrome strictly outside
any app pixel rectangle; an app frame can always draw a *fake* prompt,
so real prompts must be distinguishable by position/chrome, never by
content alone.

## Permission model

Enforcement **is** the linker:

- **Deny** = the import is never linked (fails at instantiation) or is
  linked to a stub returning a capability error (fails at call time) —
  which of the two, per interface, is a design decision.
- **Prompt-on-first-use** = sensitive host imports are async, so a call
  can suspend on a consent dialog with no app-visible API difference.
- **Revocation** = invalidate the resource handle with a defined,
  closed error case (the webcrypto error-variant discipline), never a
  trap.
- **Durable grants** keyed by (app, resource), reviewable and revocable
  in one place, with an audit trail.

Grant UX follows the **powerbox pattern** (Sandstorm's term): the
picker is the security boundary. Choosing a file/contact/document *is*
the grant, which kills prompt fatigue for the common cases; naked
permission prompts are the fallback, not the norm.

Dogfooding: storage backends (S3/WebDAV/Drive/...) and later protocol
bridges are themselves components whose network grant is scoped to
their own backend host and which only ever see ciphertext. "Pluggable
backends" is then the same plugin model with the same confinement
story, not framework code.

## Network capabilities

The honest exfiltration claim: **no unconsented flows — all flows
enumerable and auditable.** Not "exfiltration impossible": any app
granted both a data capability and any network/peer capability can
encode the former into the latter, and an attacker-controlled
destination is an exfil sink. (Mobile OSes quietly conceded this:
Android auto-grants INTERNET.) CSP and the sandbox get the UI frame to
genuinely zero *direct* network; the semantic leak through granted
channels is bounded by consent, not eliminated.

Design directions:

- **Per-destination grants** from a declarative app manifest ("talks to
  api.example.com"), not a blanket fetch capability.
- All app traffic through **framework-proxied fetch**, yielding an
  audit log a user can actually read ("this app sent 40MB to X
  today").
- **Capability-lattice install tiers**: pure-local apps install
  frictionlessly; "reads contacts + talks to the internet" gets a
  scary compound prompt. Flow-aware prompting (data classes ×
  destinations) is the differentiator over mobile-OS models.

## Data services

- **The ACL unit is the automerge document.** CRDT sync shares document
  history; sub-document read ACLs do not survive contact with the sync
  layer. Keep documents small (per-collection / per-object);
  cross-document indexing and query is the framework's job.
- **The framework owns automerge, host-side**, behind a typed WIT
  surface (a `polymorph:automerge`-shaped package): one implementation,
  one version, merge logic inside the TCB. Apps do not bring their own
  CRDT (version skew between peers, merge logic outside the TCB).
- Three distinct mechanisms, kept separate in the design:
  - **App read grants**: framework-enforced (it materializes what the
    app sees).
  - **Peer read grants**: encryption-group membership — cryptography,
    not policy code.
  - **Write grants**: signed operations validated at merge time by
    readers.
- **Backup**: encrypted snapshots + incremental chunks to dumb storage
  via provider components; iroh-blobs content addressing beneath;
  per-document keys; avoid convergent encryption. Design worked out in
  [Storage backends and the cryptographic pull layer](#storage-backends-and-the-cryptographic-pull-layer).
- **Multi-tab**: one sync engine per origin (SharedWorker / Web Locks);
  automerge tolerates the races, the write path shouldn't invite them.

Investigated 2026-08-16 (subduction as the replication layer): findings
on the [#8 thread](../../issues/8); direction in
[Provisional plan: group crypto and sync](#provisional-plan-group-crypto-and-sync).

## Storage backends and the cryptographic pull layer

Recorded 2026-08-16 from design discussion. Leaning, not ruling;
tracked with the storage issue.

**The backend is live + untrusted and its contract collapses.** It
stores ciphertext and enforces nothing semantic. Because chunks are
content-addressed and append-only, and each device writes only its own
signed head manifest (readers merge all manifests), no backend needs
conditional writes, listing, or ACLs. The required contract is:
authenticated owner PUT/DELETE, plus GET by unguessable name. That
admits S3-anything (R2, B2, AWS, MinIO, Garage), consumer drives used
as dumb stores, static HTTP hosts, CDNs, IPFS. Non-realtime sync falls
out: a blob store populated this way is a passive replica, and it
provides the one thing relays do not — asynchronous sharing (the
recipient fetches while the sharer is offline).

**Sharing needs no backend ACLs: the pull tier is cryptographic.**
Read access is already keyhive's (BeeKEM epochs). The pull tier —
who can *fetch bytes* — becomes name secrecy: per (doc × epoch)
**name-keys**, object name = HMAC(name-key, cref), optionally an outer
in-guest AEAD hiding keyhive envelope metadata from name-holders.
Name-keys travel over the E2E contact channel like any capability
("signed URLs, self-issued"); recipients need no account on any
backend. Revocation rotates the name-key alongside the BeeKEM epoch —
future objects are unfindable — and compaction relocates old objects
(the same job as PCS re-encryption). A mirror/GC service can hold the
name-key alone: the relay role reconstructed on a backend that has no
concept of it, keeping keyhive's `Access::Relay` ≈ name-key possession
uniform across realtime and storage. Read keys keep flowing through
keyhive's op stream (itself stored as blobs); the pull layer never
carries them. Lineage: Tahoe-LAFS capability strings, Cryptree/Wuala,
Peergos.

**Cooperative fetch revocation (the K_p indirection).** Some of the
fetch-revocation ACLs provided is restored by indirecting pull-key
pickup through a small deletable object: per recipient device, the
current name-key wrapped at a location derived from the pairwise
prekey secret — deleted by any of the owner's devices upon ingesting a
revocation. The honest-client discipline: **pull-layer keying material
is never persisted** — fetched per session, held in memory; content
caching is untouched (local-first requires it). Effect, by adversary:
an honest-but-uninformed revoked client (offline during revocation, or
withheld the ops — the normal delivery posture) goes dark on its next
session rather than polling until rotation; a modified client that
persisted the name-key keeps fetching already-named objects until
relocation — rotation + GC remain the only hard boundary; a
provider-colluding peer voids the pull layer wholesale (out of scope
by construction, which is also why object-versioning resurrecting a
deleted K_p is a config note, not a break — the Vanish failure mode
does not transfer). This is **cooperative revocation** — a
protocol-honesty assumption about remote clients, categorically weaker
than every other guarantee here — and the UX must not imply hard
denial. Revocation is then four layers behind one button: BeeKEM
rotation (read, hard), name-key rotation (pull-forward, hard), K_p
deletion (pull-now, cooperative), compaction relocation (pull-past,
hard, eventual) — plus, for the owner's own devices, **storage
credential rotation** (see the scenario below).

**Motivating scenario: stolen device, cracked offline later.** Theft
at T0, revocation at T1, crack at T2 > T1. The thief gets content the
device had reached by T0 and the persisted keyhive state (BeeKEM
secrets are in-guest, necessarily), which decrypts already-reached
history — the irreducible floor. They do not get: post-T1 epochs
(PCS), any pull-layer material (never persisted — crefs on disk map to
no fetchable name), a K_p bootstrap (prekey secrets are on the device,
but the object was deleted at T1), or the owner's bucket (credential
rotation at T1). Compromise narrows from *everything the device could
reach* to *everything it had reached* — and the layers act at T1,
independent of T2: revocation races the crack, not the theft, which is
what disk encryption and platform key storage buy time for. Caveats:
a crack or undetected theft before revocation is just an authorized
device (forward layers only); hardware-held identity keys survive a
crack (the webcrypto posture), BeeKEM secrets cannot — epoch rotation,
not key hardware, carries history-forward safety.

**Accepted losses vs backend ACLs** (for the threat model): no
retroactive fetch-denial against modified clients until relocation;
harvest-now-decrypt-later exposure widens from provider+members to
provider+name-holders (bounded by rotation; names leak like URLs —
logs, history — unlike keys, so prefer *expiring* URL minting as
hygiene where the backend offers it); egress abuse by name-holders on
paid-egress backends (default to private buckets + minted URLs there;
name-secrecy mode where egress is free or flat); provider metadata
unchanged (sizes, timing, and now recipient *counts* via K_p objects;
tree-ids in paths pseudonymized by the name-key already).

**Spike executed 2026-08-16 and passed**
([spikes/storage/](spikes/storage/README.md), tracked in #19): SigV4
signed in-guest via polymorph:webcrypto against a real MinIO; the
dumb-store contract confirmed sufficient (unsigned LIST and PUT
refused); an account-less recipient read via K_p → name-keys →
manifests → chunks over pure name secrecy; and the stolen-device
scenario ran as an executable assertion — a cracked-image resurrection
reads successfully *before* revocation and retrieves nothing after it
(K_p 404, no derivable names), while the owner's second device rides
the rotation. The wasip3 http client's wit-bindgen runtime (0.57) is
isolated in its own fetch component composed via `wac plug` — the
component model resolving runtime-version conflicts, and the fetch
import doubling as the per-destination network-grant seam.

**Provider order.** First: one **S3-compatible provider component**
(R2 and B2 as documented defaults — real 10 GB free tiers, R2 free
egress; MinIO/Garage cover self-host) — no external approval gates,
SigV4 is HMAC via polymorph:webcrypto (class A), network grant scoped
to one backend host (the dogfooded confinement). Fast follow: Google
Drive **as a dumb store** (15 GB, broadest accounts, `drive.file`
scope, appDataFolder; start the OAuth-verification clock early) — its
native ACLs are no longer required for sharing. WebDAV/Nextcloud
later for self-host breadth (CORS is the dragon). The #11 recovery
bundle is the special case that needs public-fetch mode: its name and
KEK both derive from the recovery phrase — fetchable with no prior
keys, by construction.

## Group crypto

The MLS question, structurally: MLS assumes a delivery service imposing
a linear order on group-changing commits; concurrent commits fork the
group. This system is partition-tolerant and peer-to-peer — concurrency
is the *normal case* — so raw MLS fights the architecture.

Candidates for the decision memo:

- **MLS** (RFC 9420) plus some ordering layer over gossip — fights the
  grain; forks and retries need connectivity to a sequencer.
- **DCGKA** (Weidner/Kleppmann et al., ["Key Agreement for Decentralized
  Secure Group Messaging with Strong Security
  Guarantees"](https://eprint.iacr.org/2020/1281)) — group keying
  designed for causal broadcast and concurrent membership changes.
- **Keyhive / BeeKEM** ([Ink & Switch](https://www.inkandswitch.com/keyhive/))
  — capability-based auth plus concurrency-tolerant group keying
  purpose-built for automerge sync. Closest-fit prior art; at minimum
  steal its decomposition, possibly track as a dependency.

CRDT-specific considerations MLS discussions won't surface:

- **History handoff**: what a new member/device receives (full history
  vs snapshot) is a policy knob with security meaning — it sets the
  read-back window.
- **Post-compromise security is weaker in practice** on a CRDT
  workload: history persists, so recovering from compromise includes
  re-encrypting the past — a rotation job, not a ratchet step.

Evaluation criteria: concurrency tolerance, spec/implementation
maturity, wasm-portability (must run in-guest or over
polymorph:webcrypto), and the FS/PCS actually delivered on a
sync-history workload rather than on paper.

Investigated 2026-08-16 (Keyhive code + design docs): findings on the
[#9 thread](../../issues/9); direction in
[Provisional plan: group crypto and sync](#provisional-plan-group-crypto-and-sync).

## Provisional plan: group crypto and sync

Recorded 2026-08-16 from the Keyhive/subduction investigation
([#9](../../issues/9), [#8](../../issues/8) carry the detailed
findings). Provisional: adopted as the working plan, converted to a
ruling only by the checkpoints at the end of this section. No
`@unstable` gates anywhere — the whole framework is unstable until
declared otherwise (see the status note at the top).

- **Group crypto (#9): Keyhive primary, DCGKA the named fallback, raw
  MLS eliminated.** MLS's delivery-service sequencing assumption is
  disqualifying for a partition-tolerant P2P system, and BeeKEM now has
  formal analysis for the decentralized case (cross-fork security;
  eprint 2026/1434) that DCGKA-era designs lacked. `keyhive_core`
  wraps behind a `polymorph:groups`-shaped WIT surface so the
  implementation stays swappable; identity signing routes through
  `polymorph:webcrypto` via keyhive's `AsyncSigner` seam (upstream
  already ships a WebCrypto signer holding a non-extractable platform
  Ed25519 key). Verified: `keyhive_core` + `beekem` + `keyhive_crypto`
  compile clean for wasm32-wasip2.
- **Sync (#8): v1 provisionally matches subduction — at three distinct
  layers.** The *domain model* is matched (sedimentree
  commits/fragments/summaries, pull policy, subscriptions: the
  vocabulary carries two paid design iterations — Beelay was scrapped
  wholesale, and the current tracker previews the mistakes a
  from-scratch design would repeat). The *WIT API* is ours, with
  subduction as the first provider behind it — mirroring its Rust API
  would export upstream churn to every consumer; the adapter absorbs
  it. The *wire and storage formats* are provisionally subduction's,
  pinned and tagged: upstream framing carries per-type schema-version
  bytes with reject-on-unknown — tagged, not negotiated. Verified:
  `subduction_core` + `sedimentree_core` + `subduction_crypto` compile
  clean for wasm32-wasip2; transports are thin (upstream's iroh 1.0
  adapter is ~1k LOC, so a `polymorph:iroh` transport is a small
  seam).
- **Cross-version compat is a day-one seam requirement.** The
  "framework ships both endpoints" mitigator holds within one user's
  devices under one origin, not across origins: release skew across
  the P2P graph is structural (origin A at release N syncs with origin
  B at N−3). The seam speaks N and accepts a defined window back;
  format generations are recorded; re-chunking/migration is a
  framework job.
- **Vocabulary adopted: pull / read / mutate / manage** (keyhive's
  access tiers). *Pull* — may fetch ciphertext, cannot decrypt — is
  the missing name for the untrusted-relay tier the trust-model
  invariant implies: it is precisely what a live-and-untrusted party
  checks.
- **Co-evolution posture.** Pin by exact version/rev; upstream
  protocol changes are migrations, not bumps (keyhive #213 — a BeeKEM
  change altering what trees mean, merged the day before the
  investigation — is the template). Track both repos and the
  keyhive-beelay Discord channel; upstream filings are individual
  decisions.
- **Recorded properties for the threat model (#1).** No forward
  secrecy, by design (causal keys: a chunk key discloses predecessor
  keys; the read-back window is a policy knob). The actual guarantees
  are PCS plus cross-fork security. Keyhive's bespoke content envelope
  (XChaCha20-Poly1305 with a keyed-BLAKE3 synthetic-nonce /
  key-commitment scheme, flagged CAUTION in their own design doc)
  requires independent review before polymorph data ships under it.
- **Spike sequence.** (1) `keyhive_core` as a wasip2 component,
  `AsyncSigner` over `polymorph:webcrypto`, membership/CGKA ops
  exchanged between two component instances over any dumb channel —
  the transport here is throwaway scaffolding, because production op
  sync belongs to the subduction bridge; the spike validates signing,
  embedding, persistence, and op semantics, and must not grow its own
  sync protocol. **Executed 2026-08-16 and passed**
  ([spikes/keyhive/](spikes/keyhive/README.md)): unpatched keyhive at
  pinned main runs as a component; cryptographic exclusion after
  revocation held under adversarial full delivery; the causal-keys
  no-FS trade observed; archive/restore works with the platform-held
  signer, and surfaced the dependency that durable browser state needs
  **platform key persistence** (feeds #11 and the webcrypto keystore
  design). (2) Subduction with a `polymorph:iroh` Transport
  implementation. **Phase 2a executed 2026-08-16 and passed**
  ([spikes/subduction/](spikes/subduction/README.md)): unpatched
  subduction at pinned main runs as a component — real handshake, sync
  convergence, and live subscription push between two instances over a
  host-shuttled wire; identity signing via `polymorph:webcrypto`. Two
  findings: wit-bindgen's `inter-task-wakeup` feature is load-bearing
  for the engine composite (without it, channel-sleeping tasks panic;
  with it, wasmtime serves them — the polymorph-iroh-era wakeup
  uncertainty resolves for the wasmtime leg), and
  `subduction_crypto::Signer::sign` is infallible, so platform-signer
  failures can only trap (keyhive's fallible `AsyncSigner` is the
  better shape; upstream-issue candidate). **Phase 2b executed
  2026-08-16 and passed**: the same guest composed with the
  component-iroh endpoint via `wac plug` runs the identical scenario —
  subduction handshake, sync convergence, live subscription push — over
  a length-framed bidirectional QUIC stream through a stock iroh relay.
  Swapping wires touched zero subduction code (two ~30-line stream-pump
  tasks feed the same frame queues), which validates the transport seam
  the plan bet on. (3) The walking skeleton — automerge ↔ subduction ↔
  keyhive over component-iroh, all components — as the #8/#9
  validation artifact, which also measures the topology question
  below. **Phase 3a executed 2026-08-16 and passed**
  ([spikes/skeleton/](spikes/skeleton/README.md)): the full content
  path in one engine composite per peer — automerge chunks encrypted
  under BeeKEM epochs, ciphertext envelopes as sedimentree blobs,
  synced over the iroh wire — with **one platform-held identity
  backing both layers**, and the **pull/read separation enforced by
  cryptography**: a revoked member keeps receiving ciphertext over the
  live subscription and cannot read it, while readable history stays
  readable. Design finding: epoch membership at *seal* time determines
  readability (a BeeKEM add is not retroactive), so the data layer
  must encode "create → add members → first seal", and late joiners
  read history only through causal keys via post-join chunks. **Phase
  3b executed 2026-08-16 and passed**: the `subduction_keyhive` bridge
  wired in — membership travels over a second stream of the same iroh
  connection, and the keyhive auth graph gates subduction's pull
  policy. Both tiers demonstrated: pre-membership and post-revocation
  pulls refused (empty diff, no information leak); crypto exclusion
  unchanged beneath. Two upstream findings: **subscriptions bypass the
  pull gate after revocation** (push path does not re-check fetch
  policy; explicit pulls refuse correctly — upstream-issue candidate),
  and **the two upstreams version-skew** (the bridge pins released
  keyhive, which predates the BeeKEM ratcheting change; a
  `[patch.crates-io]` onto the git rev compiled clean — pin keyhive and
  subduction as a *pair*).   The bridge also assumes the identity
  unification (peer id = 32-byte verifying key = keyhive identifier),
  confirming the one-key-per-device design. (4) The engine spike
  (#20 G1+G2). **Executed 2026-08-16 and passed**
  ([spikes/tasks-engine/](spikes/tasks-engine/README.md)): the
  skeleton's content spine generalized to the real automerge change
  DAG — chunk = one automerge change, cref = its `ChangeHash`, chunk
  parents = the change's `deps()` = keyhive pred-refs = sedimentree
  parents, one DAG across all three layers — with the first data
  service, `polymorph-data:tasks@0.1.0`, served from inside the engine
  composite (demo-v1 topology). Three instances (two devices + a
  collaborator) over a real relay: a genuine concurrency fork merges
  (a chunk with two parents exists), replicas converge, a revoked
  member is crypto-excluded while a remaining member rides the
  rotation in ~100 ms. Two integration findings:
  **`KeyhiveProtocol`'s event cache must be refreshed after locally
  created ops** (`sync_keyhive` serves a `PeriodicEventCache` once one
  exists; upstream's runtime refreshes on an interval — embedders that
  skip the runtime must `refresh_cache()` before syncing or every
  post-cache local op, e.g. the post-revocation rotation, is silently
  never offered to peers), and **one-shot bridge syncs need a retry
  discipline** (the spike re-syncs from read polls that find
  themselves waiting; upstream intends a periodic loop). With the
  cache refreshed, the post-revocation ciphertext did *not* reach the
  revoked subscriber — the 3b "subscriptions bypass the pull gate"
  observation is timing-dependent, not unconditional (context for the
  #17 draft).
- **Topology leaning: one engine composite, one keyhive instance.**
  `subduction_keyhive` is an in-process wrapper that *holds* the
  `Keyhive` instance, implementing subduction's connection/storage
  policy traits against it and carrying membership-op sync. Keyhive
  therefore instantiates once, inside the same component as
  subduction; the framework-facing groups surface
  (`polymorph:groups`) and the sync surface are separate WIT exports
  of that composite — consumers cannot tell it is one component.
  Splitting groups and sync into separate components would either
  duplicate keyhive state or rebuild the ~9.7k-LOC bridge across a
  component boundary that sits on per-request policy hot paths.
  Failure asymmetry, named: dropping subduction leaves the groups
  surface untouched (op transport gets rebuilt or forked); dropping
  keyhive drops the bridge too, so the DCGKA fallback includes
  rebuilding op-sync and policy enforcement — the fallback's true
  cost. One more consequence: a relay is the same composite in a
  second role — membership view plus pull policy, no content keys.
- **Conversion checkpoints (provisional → ruling).** The spikes prove
  component embeddability; convergence/partition gates expressed in
  polymorph-test go green; scaling is measured against our doc-count
  profile — doc-as-ACL-unit multiplies document count, and upstream
  subduction #268 (collections freezing at ~2,400 documents) sits on
  exactly that path. Risk facts that stay visible while provisional:
  subduction's bus factor (one primary contributor) and open semantic
  bugs (wasm memory corruption on reconnect, transient false heads);
  keyhive's empty upstream threat-model doc and open zeroization
  audit.

## Identity and devices

Leaning: **devices as leaves, a user = a group of devices, sharing
groups contain user groups.** The unification holds under failure:
"lost phone" and "removed collaborator" have the same mechanics
(rotate forward, treat history as exposed).

- Device identity substrate is already in the family: iroh endpoint IDs
  (Ed25519, the key is the address) held as polymorph:webcrypto
  non-extractable handles.
- User identity = a **signed device-list chain** (Keybase-sigchain-ish),
  wanting a small gossip/transparency story rather than a global
  directory.
- **Enrollment ceremony** (QR / short-authentication-string between
  devices) must be cheap and polished — it is also the origin-migration
  path and part of the recovery path.
- **Contact exchange**: out-of-band verification (QR/link), petnames,
  TOFU plus gossip cross-checks; no global directory in v1 (see
  [Addressing and discovery](#addressing-and-discovery)).

## Key lifecycle

Browser storage is evictable (Safari's 7-day script-writable-storage
rule for non-installed sites; `navigator.storage.persist()` is
best-effort; installed-PWA exemptions vary). Design assuming any single
device can vanish:

- **Device signing keys**: non-extractable and *disposable* —
  re-enrollment is the recovery, so it must be cheap.
- **The data-encryption root**: separate and *recoverable* — wrapped
  under a KEK derived from a recovery phrase and/or the WebAuthn **PRF
  extension** (hardware-backed; platform support floor to verify),
  backup bundle stored on the dumb storage layer.
- **Losing the last device must not mean losing the data.** Conversely
  the recovery path is the crown jewels and gets its own threat-model
  section. Escrow options (none / social / provider) deliberately
  deferred.

## Compute placement and push

"One artifact across environments" tempts running app components
headless at a provider: always-on sync peer, push generation, agents.
The cost is stated plainly: **a headless host holds plaintext (keys)
for everything that component is granted.** Not a reason to skip the
feature — a reason to surface compute placement as a powerbox decision
("run an always-on copy at your provider: it will hold keys to X and
Y"), defaulting to user-owned always-on nodes (old laptop, phone
runtime), which component-iroh's deployment matrix was built for.

Push, keeping the origin static: **the subscription is a capability.**
Web Push senders need only the subscription endpoint + VAPID key —
hand them (encrypted) to your contact group over the sync layer and
peers can wake your service worker directly, payloads E2E on top of
RFC 8291's transport encryption. Metadata cost: contacts learn your
push endpoint; the push service sees sender IPs. Open sub-question:
*who decides to notify* — peer-side decision logic covers
peer-triggered events; anything else needs something always-on.

## Developer experience

Sandstorm's postmortem lesson: porting friction killed the app
ecosystem. This is existential for the app side of the design.

- A **componentize-js SDK** that makes a normal web app port
  mechanically: a `fetch` shim mapping to capability-checked host
  fetch, a storage shim (IndexedDB/KV-shaped) mapping to framework data
  services, templates (`polymorph create-app`). The in-family precedent
  is webcrypto-componentize (crypto.subtle over WIT imports).
- A **WIT-first surface** for component-native developers (Rust, ...)
  in parallel; the budget split depends on the target persona (open).
- The embedded-UI story needs an asset pipeline (bundle →
  srcdoc/blob injection) and a dev loop (local shell, hot reload).

## Addressing and discovery

`user@host` addressing keeps trying to sneak a dynamic lookup back onto
the origin. Options:

- **Pure out-of-band contact exchange** (QR / links through the sharing
  layer): honest, static-clean, changes the product.
- **Per-user static records** (`.well-known` JSON, DNS TXT): a third
  origin class — live-ish, user-controlled, untrusted — which must
  never share the framework origin if it exists at all, and which
  complicates the byte-identical monitoring story and the accountless
  model.
- Nothing in v1.

Related: the static share-link viewer (reader page + ciphertext + key
in fragment) covers "share with a non-user" without discovery
infrastructure.

## System services: one component kind, capability profiles

Recorded 2026-08-17 from design discussion. Leaning, not ruling;
tracked with the system-services issue.

**Data services.** The mobile-OS analogy has a second half beyond app
sandboxing: shared, permission-gated data models (Contacts, Calendar,
HealthKit, ContentProviders). Here they are **schema-authority
components**: a versioned service (e.g. `polymorph-data:tasks`) owns a
partition of automerge documents — schema, policy, migrations — and
multiple apps project it (list, board, velocity chart). User-space and
sandboxed (not TCB), extensible (not vendor-blessed), E2E-synced.
Refines the #8 wording rather than reversing it: the **engine owns
CRDT/crypto/sync mechanics** (one implementation, engine-held doc
handles behind the #8 WIT surface); **each doc has exactly one schema
authority** — its service, a singleton instance per partition serving
multi-version facades (never two service versions live over one
partition); **apps never touch doc surfaces at all**.

**One component kind.** Data services and egress providers (storage
backends, LLM APIs, protocol bridges) are not structural kinds — a
component's authority is its import set, and a parallel kind taxonomy
would be a second source of truth that can lie. They are **system
services** distinguished by *computed capability profiles*: the linker
derives and displays what a component can reach. The load-bearing
badge is **transitive egress-reachability** over the composition graph
— "pure: this code cannot reach the network" — which cannot lie and
correctly handles compositions (a pure service linked to an egress
adapter is not pure; the adapter is an exfil proxy and the graph says
so). Caveat recorded: the badge covers code paths; data a pure service
writes may still travel via other components holding read + egress —
that is #7's flow matrix (data classes × destinations), the badge's
complement. Obligations attach to capabilities, not kinds: doc-partition
authority ⇒ singleton/schema-authority/facade rules; egress ⇒
destination scoping, proxied fetch, audit, and the compound prompt when
combined with data authority. Splitting one service into
pure-data + egress-adapter is an **engineering choice where it buys
failure tolerance** (high-sensitivity data with peripheral egress,
user-swappable destinations, differing trust tiers), made cheap by
composition and incentivized (purity earns lighter review) — never a
forced classification. Where the egress is the purpose (LLM chat,
CalDAV bridge), a split boundary protects nothing.

**Defaults and rules that generalize:**

- **Per-app partitions by default, everywhere** (from the calendar
  observation): a service defaults each app to its own partition;
  shared scopes are explicit user grants. Stronger than the mobile-OS
  whole-store grant, nearly free since partitions are docs (the ACL
  unit).
- **Cross-service references cross ACL units**: refs-by-id with
  graceful absence, never embedded joins.
- **Bulk data** (photos): metadata docs + blob attachments via the
  storage layer's existing chunk/name-key machinery — a
  service-declarable pattern, already spiked.
- Consent UX gains the right granularity: installing a service is the
  big HealthKit-shaped moment; app↔service grants are semantic
  ("Kanban: Tasks read/write"); service compromise is bounded by
  partition blast radius plus the egress badge.

**Hard parts, ranked:** (1) **schema migration in a multi-version,
multi-peer CRDT world** — a v3 service migrating while an offline v2
peer writes v2 shapes is concurrent schema mutation; candidate tools:
forward-compatible schemas, write-new-read-both windows,
migration-as-new-doc with forwarding, and Cambria (Ink & Switch's
schema lenses); deserves its own decision memo, the data-layer
equivalent of the group-crypto memo. (2) **Governance/fragmentation**
— competing schemas kill interop (the WinFS/semantic-desktop failure);
the ContentProviders/HealthKit lesson: ship a small curated core set
(contacts, calendar, tasks, files/photos), each arriving with apps
that prove it; community services namespaced, not blessed. (3)
Services as high-value targets — bounded by the egress badge,
partition blast radius, and install-time consent weight. File systems
are the maximal case and must not shape v1 (doc-count scale wall).

Demo tie-in: #20's G1 contract should be `polymorph-data:tasks@0.1.0`,
the first data service; the follow-on demo is **three apps, one
service** (todomvc + kanban + velocity chart over one shared task
partition — the chart reading automerge history), which exhibits the
differentiator no platform has.

**The consent surface and kernel capabilities** (2026-08-17). Does the
unification extend to the permission dialog itself — a regular
component distinguished only by a sensitive import? **Yes at the
mechanism level, no at the trust level.** Mechanically the consent
renderer is the most confinable component in the system: its profile
is `grant-table` (propose/commit) + `trusted-surface` (chrome-owned
rendering, exclusive input) + pending-request metadata — no doc
access, no egress, the "pure" badge on the thing that grants
everything else; and the curated-DOM surface mechanism (#16) can host
it in chrome space unchanged. But three things break the "just a
sensitive capability" framing: (1) **self-reference** — every grant is
mediated by the consent surface except its own; its authority is
axiomatic, appointed by the release, the fixed point of the grant
system; (2) **the badge bottoms out** — computed profiles are
*displayed by* the consent surface, so a malicious renderer defeats
the display layer that would warn about it: at this boundary
derivation hands off to **attestation** (named in the signed release,
pinned by the shell — #3 doing what the badge cannot); (3) **failure
is different in kind** — a grant-table holder mints arbitrary
authority; that is TCB membership, not blast radius. Resolution:
**one component kind, stratified capabilities.** Ordinary
capabilities are consent-grantable; **kernel capabilities**
(grant-table write, trusted-surface, linker control, keystore root,
updater) are holdable by components — keeping the kernel
micro-kernel-shaped and the consent UI swappable — but granted only
through the **appointment path** (signed release + ceremony flows the
powerbox cannot itself perform), with holders enumerated in the #1
TCB statement. Precedent both ways: Android IMEs/accessibility
services prove regular-app-with-extraordinary-capability works and
warn that its grant path must be different in kind, not just
scarier-looking. The stratification is a gradient, not a wall:
grant-minting authority is **attenuable** ("mint grants only for
scopes this service governs"), so service-shipped **picker
components** (tasks-read + grant-mint(tasks:*) on a trusted surface)
realize the powerbox — the picking is the granting — with the
sensitive authority narrowed to the vocabulary the service already
owns.

## Parked and candidate non-goals

- **Metadata privacy**: relays, push services, and origins see traffic
  timing and contact-graph shape. State as an explicit v1 non-goal
  rather than let it be discovered. Related open question: relay
  operated by the origin operator (one party sees code fetches *and*
  contact timing) vs independent relays (split view).
- **Browser support floor**: several worst cases live in Safari (the
  `webrtc` CSP directive, PRF availability, storage persistence).
- **Multi-tab / concurrency plumbing**: folded into data services.
- **Origin portability**: design before the first user exists; folded
  into origin topology.

## Prior art

- [Sandstorm](https://sandstorm.io) — grain isolation, per-grain random
  hostnames, the powerbox; postmortem: porting cost, server-hosted
  model.
- [Solid](https://solidproject.org) — data pods, but ~no app
  confinement (apps get tokens and talk to pods directly); confinement
  is this design's differentiator.
- [Peergos](https://peergos.org) — capability-based E2E filesystem
  (cryptree).
- [UCAN](https://github.com/ucan-wg/spec) / Fission — capability tokens
  for user-owned storage.
- remoteStorage / unhosted — same era and weakness as Solid.
- [Ink & Switch](https://www.inkandswitch.com/local-first/) — the
  local-first canon; [Keyhive](https://www.inkandswitch.com/keyhive/).
- [Isolated Web Apps](https://github.com/WICG/isolated-web-apps) —
  Chromium signed web bundles; install-time code integrity, not
  cross-platform.
- [Code Verify](https://github.com/facebookincubator/meta-code-verify)
  — extension-checked hash manifests for web-delivered E2E clients.
- Object-capability literature — E, CapTP, capability UX ("user
  interaction is the grant"); SES/Endo as the JS-confinement road not
  taken (components chosen instead).

## Open questions

Tracked as issues; the headline ones, verbatim from the discussion:

- Who runs home origins in practice — a flagship hosted service,
  self-hosters, or both from day one?
- Target app developer: JS devs porting web apps, or component-native
  devs?
- Is headless-at-provider execution in scope for v1?
- Does Safari have to work at launch?
- Relay: bundled with the origin operator or independent by default?
- Does the home origin ever serve per-user content?
- `user@host` discovery: wanted, or out-of-band only?
