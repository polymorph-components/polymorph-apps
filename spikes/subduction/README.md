# Subduction spike (phase 2a: embeddability + convergence)

Spike (2) from NOTES.md, "Provisional plan: group crypto and sync",
first phase: `subduction_core` embedded in a wasm32-wasip2 component,
two component instances running the **real subduction handshake and sync
protocol** over a host-shuttled wire. Phase 2b (the `polymorph:iroh`
Transport) replaces the wire; everything in-guest stays.

**Scope.** Validates that subduction's architecture — spawned listener /
manager / connection tasks communicating over async channels — runs
under wit-bindgen's async runtime on wasmtime, with identity signing
through `polymorph:webcrypto`. The host never sees a protocol concept:
it drains outboxes and delivers frames. Quarantined, delete-at-will,
wired into no CI.

## What it demonstrates

- `subduction_core` + `sedimentree_core` + `subduction_crypto` (git
  main, pinned rev) run as a wasm32-wasip2 component **without
  patches**, `std` feature on, no tokio anywhere.
- The full builder wiring in-guest: `MemoryStorage`, `OpenPolicy`, a
  `Spawn` impl over `wit_bindgen::spawn_local`, a never-firing `Timeout`
  (spike-only; a real embedding backs this with wasi:clocks), and a
  `Signer` over the `polymorph:webcrypto` ed25519 import
  (non-extractable platform handle).
- The **real handshake** (`handshake::initiate`/`respond` — signed
  challenge/response with audience binding, nonce cache, drift window)
  over shuttled frames, producing `Authenticated` connections registered
  with `add_connection`.
- Sync semantics across two instances: Alice commits, Bob
  `sync_with_peer`s to convergence (commit + blob asserted byte-equal);
  Bob commits a child; **the live subscription pushes it to Alice** with
  no explicit second sync round.

## Run it

```sh
just run       # builds the guest for wasm32-wasip2, runs the host scenario
just check     # clippy on both sides
```

Toolchain: Rust 1.97.0 + wasm32-wasip2 (pinned); wasmtime 47 +
`polymorph-webcrypto-wasmtime` host. Upstream pins are exact git revs in
the member manifests; bumps are migrations, not routine.

## Measured (wasmtime release, one machine, indicative)

- Handshake: 1 pump round, 2 frames, ~4.6 ms end to end (dominated by
  first-call code paths; subsequent ops are microseconds).
- Bob's sync round: 2 pump rounds, ~180 µs;
  `SyncStats { commits_received: 1, … }`.
- Subscription push of a new commit to the other peer: ~72 µs.
- **2 webcrypto sign calls per peer for the whole scenario** — one for
  the handshake, one per authored commit. Subduction signs rarely and
  per-op; a browser `crypto.subtle` round trip stays negligible.

## Findings that feed the tracking issues

- **`wit-bindgen`'s `inter-task-wakeup` feature is load-bearing** for
  the engine composite (#8). Subduction's architecture is spawned tasks
  sleeping on Rust-side channels; wit-bindgen 0.59 *panics* on such
  waits by default ("Rust task cannot sleep waiting only on
  Rust-originating events") unless compiled with the
  `inter-task-wakeup` cargo feature — with it, everything works on
  wasmtime. This also resolves the polymorph-iroh-era uncertainty
  ("cross-task wakeups have no channel that works on every host") for
  the wasmtime leg, and is the mechanism polymorph-iroh's own
  bounded-polling pump could retire onto (their issue #42). The deltic
  and browser legs still need the same property verified.
- **`subduction_crypto::Signer::sign` is infallible** (returns
  `Signature`, not a `Result`). A platform-backed signer (WebCrypto,
  keystore) can fail at runtime; the only expressible outcome is a
  panic, i.e. a component trap that poisons the instance. Keyhive's
  `AsyncSigner` gets this right (fallible). Worth an upstream issue;
  until then the embedding must treat signing failure as fatal.
- **Frame-oriented transport is the right seam.** Subduction's
  `Transport` (send/recv byte frames) + `Handshake` (same, pre-auth)
  mapped onto host-shuttled queues in ~80 lines, and `MessageTransport`
  adapts any such transport to the typed connection. The 2b transport
  is the same two impls over a `polymorph:iroh` QUIC stream with length
  framing.
- Subscription push works across component instances (the direction our
  data-services design hoped for): after one subscribing sync, new
  commits propagate through the standing connection without polling.

## Not validated here (phase 2b and later)

The `polymorph:iroh` Transport (endpoint component composition via
`wac plug`, relay wire, connection lifecycle under iroh's
keep-alive/idle behavior), fragments/compaction (this spike never
crosses a fragment boundary), the keyhive pull-policy bridge
(`subduction_keyhive`), browser/deltic hosting, and any scale beyond
two peers and two commits.
