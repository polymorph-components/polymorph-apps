# Keyhive spike

Spike (1) from NOTES.md, "Provisional plan: group crypto and sync":
`keyhive_core` embedded in a wasm32-wasip2 component with identity signing
routed through `polymorph:webcrypto`, two component instances exchanging
membership/CGKA ops over a throwaway host channel.

**Scope.** Validates signing, embedding, persistence, and op semantics.
Deliberately contains **no sync protocol** — the host shuttles opaque
blobs; production op sync belongs to the subduction bridge. Quarantined,
delete-at-will, wired into no CI.

## What it demonstrates

- `keyhive_core` + `beekem` + `keyhive_crypto` (git main, pinned rev,
  includes the BeeKEM ratcheting removal, upstream #213) compile and run
  as a wasm32-wasip2 component **without patches**.
- keyhive's `AsyncSigner<Local>` implemented over the
  `polymorph:webcrypto` `ed25519-sign` import: the signing key is a
  **non-extractable platform handle**; the secret never enters guest
  linear memory. keyhive's async API awaits the WIT import transparently —
  no executor shims, no `block_on`.
- The two-instance scenario, asserted by the host
  (`host/src/main.rs`):
  1. identities + contact-card exchange;
  2. doc creation, `add_member(Read)`, event transfer (bincode
     `StaticEvent`s), ingest with zero stuck events;
  3. encrypt/decrypt across instances;
  4. revoke → re-encrypt → **decrypt refused with `KeyNotFound` under
     adversarial full delivery** (Bob receives every event including the
     post-revocation CGKA rotation; exclusion is cryptographic, not a
     delivery decision);
  5. history remains readable after revocation (the causal-keys /
     no-forward-secrecy trade, observed empirically);
  6. archive → restore **with the same platform-held signer** → the
     restored instance keeps working; revocation survives the round-trip.

## Run it

```sh
just run       # builds the guest for wasm32-wasip2, runs the host scenario
just check     # clippy on both sides
```

Toolchain: pinned in `rust-toolchain.toml` (Rust 1.97.0 +
wasm32-wasip2). Host: wasmtime 47 + `polymorph-webcrypto-wasmtime`
(RustCrypto backing). Upstream pins are exact git revs in the member
manifests; bumping the keyhive rev is a migration, not a routine bump
(protocol changes like upstream #213 alter what trees mean).

## Measured (wasmtime release build, one machine, indicative only)

- Every scenario step is sub-millisecond; instantiation of both
  instances ~200µs.
- Whole scenario: **17 signature calls** across the WIT boundary for the
  document owner, 10 for the member — signing is per-op, not per-byte,
  so a platform `crypto.subtle` round-trip cost (~0.1–1ms in browsers)
  stays negligible at op rate.
- Initial membership transfer for the 2-peer doc: ~3.0 KB of events;
  post-revocation events ~1.7 KB.
- Ciphertext envelope: 194 bytes for an 18-byte plaintext
  (`EncryptedContent`: SIV nonce + PCS-key and update-op digests +
  content ref) — per-chunk overhead, amortized by sedimentree-style
  chunking in real use.
- Archive of the whole two-doc-op state: ~12 KB. Guest component:
  ~2.6 MB unoptimized-for-size release build.

## Findings that feed the tracking issues

- **Platform key persistence is the missing link for durable state in
  browsers** (#11, and the polymorph-webcrypto platform-keystore design
  issue). `try_from_archive` requires *the same signer*. With
  non-extractable keys that means the platform must persist the handle
  across sessions (browsers: `CryptoKey` structured-clone into
  IndexedDB — designed upstream, not yet on the WIT surface). This
  spike's wasmtime host holds keys in host memory, so the archive
  round-trip is validated **in-instance**; cross-session restore is
  blocked on key persistence, not on keyhive. Upstream's own wasm
  binding falls back to an in-memory signer when WebCrypto is absent —
  a posture we would not accept silently.
- **Revocation semantics match the paper trail**: exclusion is
  enforced by BeeKEM key derivation (revoked member fails with
  `KeyNotFound` even holding every op), while previously readable
  history stays readable — the recorded no-FS trade, now observed.
- **Keep driver-style WIT interfaces uniformly `async func`**: sync and
  async exports generate different host calling conventions (store vs
  accessor), and mixing them inside one `run_concurrent` scenario is
  needless friction.
- API friction encountered: none worth recording — the scenario mapped
  onto `keyhive_core`'s public API one-to-one (`contact_card` /
  `receive_contact_card`, `generate_doc`, `add_member`, `revoke_member`,
  `static_events_for_agent` / `ingest_unsorted_static_events`,
  `try_encrypt_content` / `try_decrypt_content`, `into_archive` /
  `try_from_archive`).

## Not validated here (later spikes / gates)

The subduction bridge and a `polymorph:iroh` transport (spike 2), the
walking skeleton with automerge (spike 3), browser/deltic hosting of this
same component against real `crypto.subtle`, convergence/partition gates
in polymorph-test, and scaling versus our doc-count profile.
