//! What every storage provider needs and no provider owns: the egress
//! route taxonomy (#7), the two ports the engine wires its world imports
//! to, the transport-retry wrapper every provider call goes through, and
//! the webcrypto digest/MAC primitives providers derive names with.
//!
//! Nothing here knows about keyhive, subduction or automerge: a provider
//! crate handles opaque blobs at derivable locations, and all sealing
//! stays engine-side.

use polymorph_webcrypto_guest::{
    hmac_sha2,
    sha2::{self, Sha2Variant},
    MacKeyOptions,
};

/// Which egress authority a call site is asking for (#7). This is not a
/// runtime flag the seam consults: it selects WHICH WORLD IMPORT the call
/// travels through, and the two imports are wired to different instances
/// with different (or no) credentials. Picking the wrong one attaches the
/// wrong authority at composition time, where it is visible, rather than
/// silently at request time.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Acts as the user: the wired instance signs or injects a bearer.
    Owner,
    /// Acts as the APP, never as the user: the wired instance injects
    /// app-auth (public identifiers embedded in every shipped client).
    /// Distinct from Owner because the user is not identified, and
    /// distinct from Public because the destination still demands an
    /// authenticated caller.
    Shared,
    /// Carries no identity at all: the wired instance strips any
    /// authorization and injects nothing.
    Public,
}

/// ONE raw egress attempt, routed by `Route`.
///
/// The provider crates cannot own this: the engine world's fetch imports
/// are inline anonymous interfaces, so their bindings only exist inside
/// the engine guest. This trait is that seam — the engine implements it
/// by dispatching Route to the matching world import, and providers call
/// it through `do_fetch`, never directly.
///
/// No retry, no logging, no counting policy lives here; an implementation
/// is expected to be a thin adapter (the engine's also bumps its
/// per-attempt fetch counter, which is why `do_fetch` calls this exactly
/// once per attempt).
// The guest is single-threaded, so no Send bounds anywhere; the lint's
// concern (a caller wanting Send futures) cannot arise here.
#[allow(async_fn_in_trait)]
pub trait FetchPort {
    async fn request(
        &self,
        route: Route,
        method: &str,
        url: &str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<(u16, Vec<u8>), String>;
}

/// The escrowed-credential seam (#11): hand over the string-to-sign and
/// its scope, get back a signature. See `provider_s3::s3_signed` for what
/// is handed over and why it is all public request metadata.
// Same single-threaded rationale as `FetchPort`.
#[allow(async_fn_in_trait)]
pub trait Sigv4SignPort {
    async fn sign(
        &self,
        string_to_sign: String,
        date: String,
        region: String,
        service: String,
    ) -> Result<String, String>;
}

/// A short, non-secret label for a request: method plus host and path.
/// Query strings are dropped — on the S3 path they can carry signing
/// material, and no diagnostic needs them.
pub fn request_label(method: &str, url: &str) -> String {
    let rest = url
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(url)
        .split('?')
        .next()
        .unwrap_or(url);
    format!("{method} {rest}")
}

/// One HTTP request, with **transient-failure retry and named errors**.
///
/// Both properties were bought by a live browser failure: a storage
/// setup makes ~23 sequential requests, and a single dropped connection
/// aborted the whole thing, leaving a half-configured store behind an
/// error message (`fetch: send: NetworkError…`) that named neither the
/// operation nor the host. Every provider call in these crates is
/// idempotent by construction (overwrite uploads, tolerated-conflict
/// folder creation, adopted-if-exists link minting, reads), so retrying a
/// transport failure is safe; a response — any status — is never retried
/// here, because status handling belongs to the caller.
pub async fn do_fetch(
    port: &impl FetchPort,
    route: Route,
    method: &str,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Result<(u16, Vec<u8>), String> {
    const ATTEMPTS: u32 = 3;
    let label = request_label(method, &url);
    let mut last = String::new();
    for attempt in 1..=ATTEMPTS {
        match port
            .request(route, method, &url, headers.clone(), body.clone())
            .await
        {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                last = e;
                // No backoff, deliberately: only TRANSPORT failures retry
                // here (a status — including 429/5xx — returns to the
                // caller untouched), so there is no rate limiter to
                // hammer, and the attempt count is bounded at 3.
                let _ = attempt;
            }
        }
    }
    Err(format!(
        "{label}: transport failed after {ATTEMPTS} attempts: {last}"
    ))
}

pub async fn sha256(data: &[u8]) -> Result<Vec<u8>, String> {
    let digest = sha2::make_digest(Sha2Variant::Sha256).map_err(|e| format!("digest mint: {e}"))?;
    digest.compute(data).await.map_err(|e| format!("sha256: {e}"))
}

pub async fn hmac(raw_key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    hmac_sha2::import_key_raw(
        Sha2Variant::Sha256,
        raw_key.to_vec(),
        MacKeyOptions {
            sign: true,
            verify: false,
            extractable: false,
        },
    )
    .await
    .map_err(|e| format!("hmac import: {e}"))?
    .sign(data)
    .await
    .map_err(|e| format!("hmac sign: {e}"))
}
