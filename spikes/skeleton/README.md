# Walking-skeleton spike (phases 3a + 3b)

Spike (3) from NOTES.md, "Provisional plan: group crypto and sync": the
full content path in one engine composite per peer —

```
automerge chunk ──▶ keyhive encrypt (BeeKEM epoch) ──▶ EncryptedContent envelope
      ──▶ sedimentree commit (blob = ciphertext) ──▶ subduction sync
      ──▶ length-framed QUIC stream ──▶ component-iroh endpoint ──▶ stock relay
```

— with **one platform-held webcrypto identity per peer backing both
layers** (the keyhive individual and the subduction peer are the same 32
bytes; one `WebcryptoSigner` implements keyhive's `AsyncSigner` and
subduction's `Signer`).

**Phase 3b** (current form): the `subduction_keyhive` bridge is wired
in — keyhive membership/CGKA ops travel over a second stream of the
same iroh connection (the initiator opens two tagged bidi streams:
'S' for subduction frames, 'K' for the bridge protocol), and
subduction's connection/storage policies are `SubductionKeyhive`
against the same keyhive instance, so **the auth graph gates pull**.
The host shuttles nothing. Quarantined, delete-at-will, wired into no
CI.

## What it demonstrates

- **Both tiers of the pull/read separation.** *Pull* is gated by the
  keyhive auth graph through the bridge's `StoragePolicy`: Bob's sync is
  refused (empty diff, no information leak) before membership and again
  after revocation. *Read* is gated by BeeKEM epochs: ciphertext that
  does reach him post-revocation refuses with `KeyNotFound`. One
  keyhive instance drives both gates — the engine-composite topology
  doing exactly what the provisional plan drew.
- **Membership travels over the wire**: contact cards, delegations,
  revocations, and CGKA ops flow through the bridge's signed protocol
  on the K stream; the host mediates nothing.
- Automerge as the content layer: v1 is a full save, v2/v3 are
  incremental saves; readers rebuild by decrypting chunks in causal
  order (sedimentree parents = keyhive predecessor refs = one DAG) and
  applying them; chunk ref = blake3(plaintext) serves as both the
  keyhive content ref and the sedimentree commit head.
- The engine-composite topology from NOTES.md, de facto: keyhive_core +
  subduction_core + subduction_keyhive + automerge in one component,
  `wac plug`ged with the component-iroh endpoint; the host serves wasi
  p2+p3, webcrypto, websocket, webrtc-datachannels.

## Run it

```sh
just run       # composes with the endpoint, starts a local relay, runs
just check     # clippy on both sides
```

Same checkout requirements as the subduction spike (polymorph-iroh at
`IROH_CHECKOUT`, endpoint component + relay built).

## Measured (wasmtime release, one machine, indicative)

- Subduction handshake over iroh: ~42 ms; Bob's first sync: ~23 ms;
  subscription push of a new ciphertext: ~20–28 ms.
- Whole-scenario platform signing: 21 calls for Alice (keyhive
  membership + CGKA ops, subduction handshake, one per authored chunk),
  11 for Bob.
- read-doc (decrypt-all + automerge rebuild, 2–3 chunks): ~100–170 µs.

## Findings that feed the tracking issues

- **Upstream gap: subscriptions bypass the pull gate after revocation.**
  The pre-existing subscription kept pushing new ciphertext to the
  revoked subscriber (`authorize_fetch`/`filter_authorized_fetch` are
  not re-checked on the push path); explicit pulls are refused
  correctly. The crypto layer held regardless (`KeyNotFound`), which is
  why the defense-in-depth framing matters — but the pull tier should
  close on revocation too. Upstream-issue candidate for subduction.
- **Upstream version skew, absorbed by one patch**: subduction_keyhive
  depends on the *released* keyhive (crates.io 0.5.0), which predates
  the BeeKEM ratcheting change the spikes pin. A workspace
  `[patch.crates-io]` unifying on the git rev compiled and ran without
  any code changes — the bridge is source-compatible with keyhive main,
  but the two upstreams do not move in lockstep; the engine composite
  must pin them as a *pair*.
- **The bridge assumes the identity unification**: its policy converts
  subduction `PeerId`s to keyhive identifiers directly, and its peer ids
  are 32-byte verifying keys — the one-key-per-device design the plan
  chose is also upstream's assumption.

- **Epoch membership at seal time determines readability** (#9, #8).
  The first run sealed v1 *before* adding Bob; Bob then correctly failed
  with `KeyNotFound` on v1 despite holding every membership and CGKA
  event — a BeeKEM add grants the current epoch, not retroactive ones.
  The fix (and the rule the framework's data layer must encode):
  **create doc → add members → first seal**. Corollary for the
  history-handoff design question: a member added later reads history
  only through keyhive's causal keys, i.e. via a chunk sealed *after*
  their add whose envelope chain reaches back — "seal something after
  every membership change" is the operational rule to design around
  (or `try_causal_decrypt_content` + ciphertext store, unexercised
  here).
- **The one-identity unification works as designed** (#10): a single
  non-extractable webcrypto key backs keyhive signing (fallible seam)
  and subduction signing (infallible seam) with the same 32-byte id on
  both layers — the devices-as-leaves model's substrate, running.
- The two prior spikes' components composed without friction: the
  skeleton guest is spike 1 + spike 2 + ~150 lines of content spine; no
  upstream patches, same pins.

## Not validated here (later)

Relay-role deployment (a third pull-only peer enforcing the gate for
others), fragments/compaction, multi-doc scale (upstream subduction
#268 sits on our load-bearing path), reconnection and iroh idle
lifecycle, browser/deltic legs, convergence gates in polymorph-test,
and archive/restore of the combined engine state.
