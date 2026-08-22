# runtime/ — the embedding runtime

This is what any polyvisor embedder needs to run an engine composite,
with or without the visor UI (#73's ruling: graduated out of
`demo/host` — the visor's demo was the only consumer, but the code
itself is not visor-specific). It began life inside `demo/host/` and
`demo/tools/`; the demo (`demo/host/demo.ts` and its bringup/probe
entrypoints) is still its one consumer, importing these modules by
relative path.

- **`engine.ts`** — the deltic embedding adapter for the engine
  composite: envelope loading, import-record assembly (WASI batteries,
  a fetch-backed `wasi:http`, deltic ports, a sockets stub), typed
  `driver`/`tasks` views over the composite's exports, and the
  per-instance import-fragment freshness bookkeeping that makes
  repeated instantiation cheap.

- **`keystore.ts`** — the #11 escrow slice: signing credentials held as
  non-extractable WebCrypto handles, with exactly one moment of
  cleartext (the escrow ceremony itself). `exportKey` is banned from
  this file and grep-enforced — see `demo/scripts/check-invariants.sh`
  invariant (d).

- **`pairing-engine.ts`** — the real `PairingDriver` over the engine
  composite. The `PairingDriver` CONTRACT type itself stays in
  `visor/ui/pairing-driver.ts` (the visor owns the contract); this file
  is the implementation. The mock alternative used to exercise the
  visor without a running engine stays with the demo, at
  `demo/host/pairing-mock.ts` — it isn't a runtime concern.

- **`stubs.ts`** — the browser-profile `wasi:sockets` stub the
  composite's imports need to satisfy, even though nothing in a
  browser embedding actually opens a socket.

- **`tools/translate.ts`** — build-time translation from a component
  binary to an envelope (plan + FACT adapters). This runs at build
  time, not at import time, but it's an embedder concern like the
  rest: whoever embeds the engine has to produce the envelope somehow.

## Resolution model

These modules import `@deltic/*` and `@polymorph/*` packages by BARE
specifier. They are not resolved here — the EMBEDDER's own deno config
maps them (see `demo/deno.json`'s module-identity comment for why: the
mapping has to live with the consumer, not the runtime, or two
embedders in the same process tree could get two different identities
for what should be the same module). `demo/deno.json` is the only
example of that mapping so far.
