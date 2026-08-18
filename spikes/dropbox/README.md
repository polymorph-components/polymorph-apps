# Dropbox spike: the link-capability pull strategy

The #19 fast-follow after [spikes/storage/](../storage/README.md): the
dumb-store contract implemented over **consumer Dropbox** (free-tier
app-folder app), exercising the *link-capability* strategy from the #19
capability profile — shared links as container capabilities, hard
server-side revocation, pickup objects as stable per-recipient files with
their own revocable links. Same two-component composition as the storage
spike (`fetcher` + `guest` via `wac plug`), same host shape, run against
the **live API** over TLS.

The strategy delta vs S3, by design: no name secrecy (names are plain
derivable paths; the folder link gates access, and within-container
listing by capability holders is harmless — one readership per
container), no K_p relocation/compaction (revoking the container link
kills pull-now AND pull-past server-side), and the pickup object's own
file link is the recipient's standing capability — overwritten in place
on rotation, revoked on revocation.

## What it demonstrates

- **The dumb-store floor over Dropbox**: path-addressed owner writes
  (Bearer), overwrite-in-place at stable addresses, implicit parent
  creation; owner reads by path — an owner device converges through the
  store without the pull tier existing at all.
- **Account-less recipient over links**: Bob holds no Dropbox account and
  no token; his fetches carry app auth only (Basic app-key:app-secret —
  public identifiers that ship in any client). Pickup link → sealed
  container link → readkeys → signed manifests → chunks, all by derived
  relative paths under the folder link.
- **Hard revocation, the assertion the S3 strategy cannot make**: the
  cracked image deliberately hoards the resolved container link (a labeled
  no-persist violation modeling a maximally dishonest client). A
  resurrection of that image reads fine *before* revocation (image
  sufficiency) and retrieves **nothing** after it — the standing pickup
  link AND the hoarded container link are both refused server-side within
  ~1s. Under name secrecy, the equivalent hoard keeps fetching until
  relocation; here the four-layer revocation model collapses: pull-now +
  pull-past = one `revoke_shared_link`, pull-forward = re-mint on the same
  folder (zero data movement, no re-encryption, no compaction).
- **Rotation ridden in place**: the remaining recipient (Carol) reads v3
  through the SAME pickup link she was granted at the start — her pickup
  object was overwritten with the new container link, and file links
  survive overwrite. No new capability was ever delivered.
- **Refusal posture**: unknown names and revoked links are the same 409
  (no existence oracle); fetches with no credential at all are refused
  (401 — the app key is the anonymous-fetch mediator); writes without the
  owner token are refused (401/400 — both observed live, the invariant is
  refusal).

## Run it

Needs a Dropbox app (App folder access; scopes `files.content.write`,
`files.content.read`, `files.metadata.read`, `sharing.write`,
`sharing.read`) and a creds file — default `~/tmp/dropbox-app.json`,
override with `DROPBOX_APP_JSON`:

```json
{ "appKey": "...", "appSecret": "...", "accessToken": "..." }
```

Console-generated access tokens are short-lived (~4h); regenerate in the
App Console when runs start failing with `expired_access_token`.

```sh
just probe  # raw-HTTP platform probes as executable assertions (27)
just run    # builds both guests, composes, runs the scenario live
just check  # clippy on all three crates
```

Everything is created under a random `/run-*` root in the app folder and
deleted at the end of a passing run (an aborted run leaves its root —
delete it in the Dropbox UI or with files/delete_v2).

Toolchain: Rust 1.97.0 + wasm32-wasip2; wasmtime 47 with wasi p2 + p3,
`wasmtime-wasi-http` (p3, TLS via its default rustls send-request), and
`polymorph-webcrypto-wasmtime`.

## Measured (one machine, free Dropbox account, indicative)

- Whole scenario ~50 s wall; consumer-API latency class: ~1.2–3 s per
  logical op (create-doc 2.6 s, grant 3.8 s, author 2 s, recipient session
  ~3 s, revoke — five API calls — 5.3 s). MinIO was ~2 ms/op: this tier is
  the non-realtime path, as designed.
- Revocation propagation: stock client refused **458 ms** after revoke;
  cracked image (pickup + hoarded links) refused **880 ms** after.
  probe.sh measured 603 ms for the raw link. All well under user-action
  timescales.
- HTTP requests for the full scenario: owner 23, second device 6,
  recipient 12 (Bob), 11 (Carol).

## Findings

- **`get_shared_link_file` is the account-less recipient path**, verbatim
  from the API spec (`auth = "app, user"`), and it resolves relative
  paths at fetch time — overwrite-in-place is fully compatible with both
  folder and file links (probes P3/P8).
- **Revocation is hard, retroactive, and near-immediate** (P4); re-minting
  on the same folder yields a fresh URL. Rotation without data movement.
- **The ancestor-link rule is real** (P5): a link on a parent folder
  serves children even after the child's own link is revoked. Conformance
  rule: mint links only on leaf containers (per-doc folders, pickup
  files); never on the store root or intermediate directories.
- **Free-tier gates**: no expiring links (`settings_error/not_authorized`,
  P6) — revocability substitutes; 2 GB quota.
- **CORS**: the API host preflights cleanly with `Authorization` +
  `Dropbox-API-Arg` (browser recipients work); the tokenless `?dl=1` path
  works natively but its first redirect hop (www.dropbox.com) carries no
  ACAO — a CLI nicety, not a browser path (P7/P9).
- **Refusal statuses wobble**: the same bad-auth write was refused 401 on
  one run and 400 on the next. Assert refusal classes, not exact codes.
- **Network grant for this provider**: `api.dropboxapi.com` +
  `content.dropboxapi.com` (plus `www.dropbox.com`/`*.dl.dropboxusercontent.com`
  only if the tokenless path is ever used).
- The app secret ships in any real client and therefore degrades to a
  public identifier: it mediates fetch quota/abuse, never confidentiality
  — same class as a Google API key (threat-model entry).

## Not validated here (later)

Refresh-token flow (console tokens are short-lived; a real provider
component holds a refresh token and mints access tokens — one more RPC on
the same hosts), rate-limit behavior under fan-out (429/`Retry-After`),
large objects (`files/upload` single-call cap is 150 MB; upload sessions
beyond), the production-approval path for >500 users, per-identity
shared-folder grants (deliberately unused: recipients would need accounts
and pay quota for mounted folders), and the real keyhive epoch/op-stream
integration (this spike's readkeys/pickup blobs are labeled stand-ins,
same as the storage spike).
