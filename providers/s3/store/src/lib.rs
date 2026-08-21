//! The S3-compatible provider: name secrecy + cooperative deletion.
//!
//! Object names are HMAC-derived from a per-epoch name-key, so the bucket
//! can serve unsigned public GETs without leaking what it holds; writes
//! ride SigV4 over the owner route. Blob CONTENTS are none of this
//! crate's business — sealing stays engine-side and everything here moves
//! opaque bytes to derivable names.

use std::time::{SystemTime, UNIX_EPOCH};

use provider_common::{do_fetch, hmac, sha256, FetchPort, Route, Sigv4SignPort};

/// S3-compatible store config: ADDRESSING ONLY. The signing credential
/// lives behind the wired `store-signer` instance (#11) and the egress
/// authority behind the wired `store-owner-fetch` instance (#7); the
/// access key is a public identifier that travels in the Authorization
/// header in clear. An empty access key means this instance only reads
/// (unsigned GETs over the public tier).
pub struct S3Cfg {
    pub endpoint: String,
    pub bucket: String,
    pub access: String,
}

// SigV4 request signing, split across the trust boundary (#11): the guest
// builds the canonical request and the string-to-sign — all of it public
// request metadata — and asks the wired `store-signer` instance for the
// signature. The credential's key bytes never enter guest memory, so a
// compromised guest can forge signatures only for requests the signer
// agrees to sign, not for the account at large.

/// Civil date from days since the epoch (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn amz_dates() -> (String, String) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_secs() as i64;
    let (y, mo, d) = civil_from_days(secs.div_euclid(86400));
    let rem = secs.rem_euclid(86400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let date = format!("{y:04}{mo:02}{d:02}");
    let amz = format!("{date}T{h:02}{mi:02}{s:02}Z");
    (date, amz)
}

fn host_of(endpoint: &str) -> String {
    endpoint
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

pub async fn s3_signed(
    st: &S3Cfg,
    port: &impl FetchPort,
    signer: &impl Sigv4SignPort,
    method: &str,
    key: &str,
    query: &str,
    body: Vec<u8>,
) -> Result<(u16, Vec<u8>), String> {
    let host = host_of(&st.endpoint);
    let path = if key.is_empty() {
        format!("/{}", st.bucket)
    } else {
        format!("/{}/{}", st.bucket, key)
    };
    let (date, amz) = amz_dates();
    let payload_hash = hex::encode(sha256(&body).await?);

    let canonical_headers =
        format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz}\n");
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request =
        format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{date}/us-east-1/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz}\n{scope}\n{}",
        hex::encode(sha256(canonical_request.as_bytes()).await?)
    );

    // The escrowed-credential seam: the date/region/service scope goes
    // over with the string-to-sign so the signer can REFUSE out-of-scope
    // work. Everything handed over is already public request metadata.
    let signature = signer
        .sign(
            string_to_sign,
            date.clone(),
            "us-east-1".to_string(),
            "s3".to_string(),
        )
        .await
        .map_err(|e| format!("sigv4 signer: {e}"))?;
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        st.access
    );

    let url = if query.is_empty() {
        format!("{}{path}", st.endpoint)
    } else {
        format!("{}{path}?{}", st.endpoint, query.trim_end_matches('='))
    };
    // Owner tier: this request acts as the user's storage account.
    do_fetch(
        port,
        Route::Owner,
        method,
        url,
        vec![
            ("x-amz-date".into(), amz),
            ("x-amz-content-sha256".into(), payload_hash),
            ("authorization".into(), authorization),
        ],
        body,
    )
    .await
}

pub async fn put_object(
    st: &S3Cfg,
    port: &impl FetchPort,
    signer: &impl Sigv4SignPort,
    key: &str,
    body: Vec<u8>,
) -> Result<(), String> {
    let (status, resp) = s3_signed(st, port, signer, "PUT", key, "", body).await?;
    if status == 200 {
        Ok(())
    } else {
        Err(format!("PUT {key}: {status} {}", String::from_utf8_lossy(&resp)))
    }
}

pub async fn delete_object(
    st: &S3Cfg,
    port: &impl FetchPort,
    signer: &impl Sigv4SignPort,
    key: &str,
) -> Result<(), String> {
    let (status, resp) = s3_signed(st, port, signer, "DELETE", key, "", Vec::new()).await?;
    if status == 204 || status == 200 {
        Ok(())
    } else {
        Err(format!("DELETE {key}: {status} {}", String::from_utf8_lossy(&resp)))
    }
}

/// Unsigned GET: the account-less pull path (availability by name
/// secrecy). Routed Public, so the request is anonymous by construction —
/// the wired instance holds no identity and strips any authorization.
pub async fn get_object_unsigned(
    st: &S3Cfg,
    port: &impl FetchPort,
    key: &str,
) -> Result<Option<Vec<u8>>, String> {
    let url = format!("{}/{}/{}", st.endpoint, st.bucket, key);
    let (status, body) = do_fetch(port, Route::Public, "GET", url, Vec::new(), Vec::new()).await?;
    match status {
        200 => Ok(Some(body)),
        404 | 403 => Ok(None),
        other => Err(format!("GET {key}: {other}")),
    }
}

/// Name-keyed object names: hex(HMAC(name-key, kind || id)).
pub async fn object_name(name_key: &[u8; 32], kind: &[u8], id: &[u8]) -> Result<String, String> {
    let mut data = kind.to_vec();
    data.extend_from_slice(id);
    Ok(hex::encode(hmac(name_key, &data).await?))
}

/// K_p location. Spike simplification: derived from public ids (doc,
/// owner, member), so members can compute it with no shared secret and
/// no prekey-set agreement; the payload is still prekey-wrapped, and
/// revocation deletes the object. Production wants a pairwise-secret
/// location (existence privacy) — a #19/#10 design item.
pub async fn kp_location(doc: &[u8], owner: &[u8], member: &[u8]) -> Result<String, String> {
    let mut data = b"kp".to_vec();
    data.extend_from_slice(doc);
    data.extend_from_slice(owner);
    data.extend_from_slice(member);
    Ok(hex::encode(sha256(&data).await?))
}
