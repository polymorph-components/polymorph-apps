# polymorph-apps design notes

Consolidated from the founding design discussion (2026-08-16).

**Status: nothing in this document is decided.** It records the design
sketch, the analysis, and the current leanings that the tracking issues
start from. Open questions live in the issue tracker, not here; when a
topic is resolved, the ruling and its rationale land in this document
(or a dedicated doc it links) and the issue closes.

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
  per-document keys; avoid convergent encryption.
- **Multi-tab**: one sync engine per origin (SharedWorker / Web Locks);
  automerge tolerates the races, the write path shouldn't invite them.

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
