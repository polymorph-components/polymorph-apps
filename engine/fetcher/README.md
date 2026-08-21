# engine-fetcher — no longer part of the engine composite

This component wraps `wasi:http`'s async client behind the generic
`polymorph:fetch/fetch` interface. It was the engine guest's network
seam until the storage-egress retrofit (#7/#11): the guest now imports
three *named* world imports (`store-owner-fetch`, `store-public-fetch`,
`store-signer`), because authority lives in the wired instance and is
selected by import name — a single generic fetch implementation cannot
express the owner/anonymous distinction.

It is kept in-tree as a reference implementation of the seam (and is
still built by `just fetcher` / `just check`), but `just compose` no
longer plugs it in. The demo panels never used it.
