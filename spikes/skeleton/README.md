# Walking-skeleton spike (phase 3a)

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

**Phase 3a scope.** Keyhive membership/CGKA events are shuttled by the
host (`kh-events-for-peer` / `kh-ingest-events`); production membership
sync and keyhive-gated pull policy belong to the `subduction_keyhive`
bridge (phase 3b). The content path — what the skeleton exists to
validate — runs entirely over the real wire. Quarantined,
delete-at-will, wired into no CI.

## What it demonstrates

- The **pull/read separation, cryptographically enforced**: after Alice
  revokes Bob and authors v3, the v3 *ciphertext still reaches Bob* over
  the live subscription (pull — what an untrusted relay does), but his
  decrypt refuses with `KeyNotFound` (read); his reconstructed document
  stays at v2 while Alice reads all three versions.
- Automerge as the content layer: v1 is a full save, v2/v3 are
  incremental saves; readers rebuild by decrypting chunks in causal
  order (sedimentree parents = keyhive predecessor refs = one DAG) and
  applying them; chunk ref = blake3(plaintext) serves as both the
  keyhive content ref and the sedimentree commit head.
- The engine-composite topology from NOTES.md, de facto: keyhive_core +
  subduction_core + automerge in one component, `wac plug`ged with the
  component-iroh endpoint; the host serves wasi p2+p3, webcrypto,
  websocket, webrtc-datachannels.

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

## Not validated here (phase 3b and later)

The `subduction_keyhive` bridge (membership-op sync over the wire,
keyhive-gated pull policy replacing `OpenPolicy` — the relay-enforcement
half of pull/read), fragments/compaction, multi-doc scale (upstream
subduction #268 sits on our load-bearing path), reconnection and iroh
idle lifecycle, browser/deltic legs, convergence gates in
polymorph-test, and archive/restore of the combined engine state.
