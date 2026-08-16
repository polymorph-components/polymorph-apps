# Subduction spike (phases 2a + 2b)

Spike (2) from NOTES.md, "Provisional plan: group crypto and sync":
`subduction_core` embedded in a wasm32-wasip2 component, two component
instances running the **real subduction handshake and sync protocol**
over two interchangeable wires:

- **Phase 2a (shuttle)**: the host drains each instance's outbox into
  the other's inbox — embeddability and convergence semantics with the
  dumbest possible wire.
- **Phase 2b (iroh)**: the same guest composed with the
  [component-iroh](https://github.com/polymorph-components/polymorph-iroh)
  endpoint via `wac plug`; the wire is one length-framed bidirectional
  QUIC stream, end-to-end through a stock `iroh-relay`. The subduction
  side is unchanged — the frame queues are fed by two stream-pump tasks
  instead of host exports.

**Scope.** Validates that subduction's architecture — spawned listener /
manager / connection tasks communicating over async channels — runs
under wit-bindgen's async runtime on wasmtime, with identity signing
through `polymorph:webcrypto`, and that subduction's `Transport` seam
composes with the polymorph:iroh endpoint surface. Quarantined,
delete-at-will, wired into no CI.

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
- **Phase 2b**: the identical scenario with the wire replaced — iroh
  identities minted through the endpoint's own webcrypto import
  (`identity-generate`, non-extractable), endpoints bound to a local
  relay, initiator connect + acceptor accept, one bidi stream, u32-LE
  length framing, and the same `Transport`/`Handshake` queue impls fed
  by two pump tasks. Subduction's handshake, sync round, and
  subscription push all run over real QUIC through the relay.

## Run it

```sh
just run        # phase 2a: composed component, host-shuttled wire
just run-iroh   # phase 2b: starts a local iroh-relay, runs over QUIC
just check      # clippy on both sides
```

Toolchain: Rust 1.97.0 + wasm32-wasip2 (pinned); wasmtime 47 +
`polymorph-webcrypto-wasmtime`, `wasmtime-websocket`, and
`wasmtime-webrtc-datachannels` hosts (the latter two at the revs
polymorph-iroh pins). Upstream pins are exact git revs in the member
manifests; bumps are migrations, not routine.

Phase 2b additionally needs a polymorph-iroh checkout (default
`../../../polymorph-iroh`, override with `IROH_CHECKOUT`) that has built
the endpoint component (`cargo build -p iroh-endpoint --target
wasm32-wasip2 --release`) and the relay (`just relay-build`). The
endpoint artifact must be built from the same checkout state as the WIT
vendored under `guest/wit/deps/` (copied from its `endpoint-demo/wit/deps`
at rev `1808ccc`); `wac plug` fails loudly on drift.

## Measured (wasmtime release, one machine, indicative)

Shuttle wire (2a):

- Handshake: 1 pump round, 2 frames, ~4.6 ms end to end (dominated by
  first-call code paths; subsequent ops are microseconds).
- Bob's sync round: 2 pump rounds, ~180 µs;
  `SyncStats { commits_received: 1, … }`.
- Subscription push of a new commit to the other peer: ~72 µs.

Iroh wire (2b), through a local stock relay:

- `iroh-bind` (endpoint standup + relay connection): ~21 ms first, ~0.5
  ms second.
- Subduction handshake over the QUIC stream: ~38 ms (relay round
  trips).
- Bob's sync round: ~23 ms; subscription push: ~18 ms.

Both wires: **2 webcrypto sign calls per peer for the whole scenario**
— one for the subduction handshake, one per authored commit (iroh's own
identity signing happens inside the endpoint component against its own
webcrypto import). Subduction signs rarely and per-op; a browser
`crypto.subtle` round trip stays negligible.

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
- **Frame-oriented transport is the right seam — confirmed twice.**
  Subduction's `Transport` (send/recv byte frames) + `Handshake` (same,
  pre-auth) mapped onto queue impls in ~80 lines, and the iroh wire
  reused them unchanged: two ~30-line pump tasks bridge the queues to a
  length-framed QUIC stream. Swapping wires touched zero subduction
  code.
- **Composition drift fails loudly and early**: `wac plug` refused an
  endpoint artifact built before the current WIT ("no matching
  imports"), which is the desired failure mode for the pinned-rev
  discipline.
- Subscription push works across component instances (the direction our
  data-services design hoped for): after one subscribing sync, new
  commits propagate through the standing connection without polling.

## Not validated here (later)

Long-lived connection lifecycle (iroh idle/keep-alive behavior —
upstream polymorph-iroh #70 — and subduction reconnection), the UDP and
WebRTC paths (this spike dials the relay path only),
fragments/compaction (the scenario never crosses a fragment boundary),
the keyhive pull-policy bridge (`subduction_keyhive`), browser/deltic
hosting, and any scale beyond two peers and two commits.
