# Storage spike: the S3-compatible provider and the cryptographic pull layer

The #19 spike: an S3-compatible storage provider signed **in-guest**
(SigV4 via `polymorph:webcrypto` HMAC/SHA-256) plus the pull layer from
NOTES.md §"Storage backends and the cryptographic pull layer" — per-epoch
name-keys, HMAC-derived object names, per-recipient **K_p** pickup
objects, cooperative fetch revocation — run against a real S3 server
(MinIO), with the stolen-device scenario as an executable assertion.

**Two guest components, composed.** The wasip3 crate (async
`wasi:http@0.3` client, `http_compat`) pins wit-bindgen 0.57;
`polymorph-webcrypto-guest` pins 0.59; one component cannot carry both
runtimes. So the HTTP client lives in its own `fetcher` component
exporting a minimal buffered `polymorph:fetchspike/fetch` interface, and
`wac plug` composes it with the storage guest — the component model
doing runtime-version isolation, and the fetch import doubling as the
seam where the framework's per-destination network grant attaches.

## What it demonstrates

- **SigV4 in-guest over platform crypto**: the signing chain
  (HMAC-SHA256 ladder, payload/canonical hashing) runs entirely through
  `polymorph:webcrypto`; MinIO accepts the signatures (bucket create,
  policy put, object put/delete).
- **The dumb-store contract is sufficient**: owner-authenticated
  PUT/DELETE plus GET-by-unguessable-name. No listing (probed: refused),
  no backend ACLs, no conditional writes. Public read is per-object via
  a bucket policy set in-guest; names are 256-bit HMAC outputs.
- **Device convergence through the bucket**: the second device adopts
  the doc keys (device-group stand-in) and reconstructs from signed
  per-device manifests + chunks.
- **Account-less recipient**: Bob holds no backend credentials at all.
  His session derives the pairwise K_p location (X25519 + HKDF against
  the owner's public key), fetches K_p (name-key keychain), readkeys
  (content-key keychain — the labeled stand-in for keyhive's op
  stream), manifests, chunks — all unsigned GETs.
- **The no-persist discipline is structural**: all pull-layer material
  in `read-shared` is function-local; instance state persists only
  identity, config, and fetched plaintext. `cracked-image` therefore
  contains exactly what an honest client's disk contains (worst-case
  soft identity keys, deliberately extractable here).
- **The stolen-device assertion, both halves**:
  1. a resurrection of the cracked image **before** revocation reads
     the doc — the image is sufficient, so the later darkness is caused
     by the mechanism, not by missing data;
  2. after `revoke` (K_p deleted, epoch rotated), the **same image**
     retrieves nothing: the K_p it can locate is gone (404), and no
     other object name is derivable from anything on disk.
- **Cooperative revocation ordering**: stock client dark on its next
  session; the owner's other device rides the rotation (new epoch keys
  via the device-group stand-in) and reads all three versions.

## Run it

```sh
just run    # builds both guests, composes, fetches MinIO once into
            # .deps/, runs it as a user process, drives the scenario
just check  # clippy on all three crates
```

Toolchain: Rust 1.97.0 + wasm32-wasip2; wasmtime 47 with wasi p2 + p3,
`wasmtime-wasi-http` (p3 feature), and `polymorph-webcrypto-wasmtime`.
MinIO is fetched from dl.min.io on first run (single static binary, run
as the user; container images were abandoned — rootless-podman UID
mapping friction).

## Measured (one machine, indicative)

- Whole scenario wall time ~40 ms after setup; recipient session
  (K_p + readkeys + manifest + 2 chunks, unsigned): ~1.8 ms.
- `revoke` (delete K_p + rotate epoch + republish manifest): ~2.7 ms.
- HTTP request counts: owner 12, second device 6, recipient 12 for the
  full scenario.

## Findings

- **wasi:http@0.3 outgoing bodies are chunked**; MinIO's
  PutBucketPolicy requires Content-Length, and a bodyless CreateBucket
  confuses its XML parser. Both resolved guest-side (explicit
  `content-length` header from the buffered fetcher; explicit
  `CreateBucketConfiguration` body). Worth remembering for R2/B2
  interop testing.
- **The two-component split is the pattern for runtime-version
  conflicts**: wit-bindgen 0.57 (wasip3) and 0.59 (webcrypto) coexist
  with zero friction across a `wac plug` boundary. The same shape will
  serve any future dependency that drags its own bindings runtime.
- The provider-config conformance list from #19 gets its first two
  entries validated: public-read-no-list policy, and (implicitly)
  versioning-off — plus the two probes (unsigned PUT and LIST refused)
  that a provider checker should run.

## Not validated here (later)

R2/B2 against the same component (SigV4 quirks, presigned-URL minting
as leak hygiene), TLS endpoints, the real keyhive epoch/op-stream
integration (this spike's readkeys/epoch blobs are labeled stand-ins),
relocation/GC (old-name compaction), storage-credential rotation
(noted as the owner-device step in NOTES), multipart/large objects,
and the Drive-as-dumb-store provider.
