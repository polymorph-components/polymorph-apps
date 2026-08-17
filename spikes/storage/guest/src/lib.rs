//! The storage-spike guest: an S3-compatible provider signed in-guest
//! (SigV4 over polymorph:webcrypto HMAC/SHA-256) plus the cryptographic
//! pull layer — per-epoch name-keys, HMAC-derived object names,
//! per-recipient K_p pickup objects, cooperative fetch revocation.
//!
//! HTTP arrives through the composed `polymorph:fetchspike/fetch` import
//! (a separate component wrapping wasip3's wasi:http@0.3 client). All
//! crypto goes through polymorph:webcrypto: SigV4 and name derivation are
//! HMAC-SHA256, pairwise capabilities are X25519+HKDF, content sealing is
//! AES-256-GCM, manifests are Ed25519-signed.
//!
//! The no-persist discipline is structural: `read-shared` derives every
//! pull-layer key as a local and drops it on return; instance state holds
//! only identity, config, and fetched plaintext.

wit_bindgen::generate!({
    path: "wit",
    world: "spike",
    generate_all,
});

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use polymorph_webcrypto_guest::{
    aes_gcm::{self, AesVariant},
    ed25519, hkdf_sha2, hmac_sha2,
    sha2::{self, Sha2Variant},
    x25519, Aead, AeadKeyOptions, AgreementKeyOptions, AgreementSecretKey, DeriveInput, Mac,
    MacKeyOptions, SigningKey, SigningKeyOptions,
};
use serde::{Deserialize, Serialize};

use exports::polymorph::storage_spike::driver::{DocView, Guest};
use polymorph::fetchspike::fetch;

// --- serialized formats ---

#[derive(Serialize, Deserialize)]
struct KpBlob {
    /// (epoch, name-key) keychain: current epoch grants history names.
    epochs: Vec<(u32, [u8; 32])>,
}

#[derive(Serialize, Deserialize)]
struct ReadKeys {
    /// (epoch, content-key) keychain — spike stand-in for keyhive's op
    /// stream fetched via name-keys.
    epochs: Vec<(u32, Vec<u8>)>,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    doc: Vec<u8>,
    /// Append-ordered (cref, epoch) entries; the last readable entry is
    /// the current text.
    entries: Vec<([u8; 32], u32)>,
    device: [u8; 32],
}

#[derive(Serialize, Deserialize)]
struct SignedManifest {
    manifest: Vec<u8>,
    sig: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct EpochBlob {
    name_keys: Vec<(u32, [u8; 32])>,
    content_keys: Vec<(u32, Vec<u8>)>,
}

#[derive(Serialize, Deserialize, Clone)]
struct SharedCtx {
    doc: Vec<u8>,
    owner_pub: Vec<u8>,
    author_devs: Vec<Vec<u8>>,
}

/// Everything an honest client persists (worst-case soft identity keys).
/// Deliberately absent: name-keys, content-keys, K_p contents.
#[derive(Serialize, Deserialize)]
struct CrackedImage {
    x25519_secret_jwk: String,
    x25519_pub: Vec<u8>,
    endpoint: String,
    bucket: String,
    shared: Option<SharedCtx>,
    texts: Vec<String>,
}

// --- instance state ---

struct DocState {
    name_keys: Vec<[u8; 32]>,
    content_keys: Vec<Vec<u8>>,
    entries: Vec<([u8; 32], u32)>,
    recipients: Vec<Vec<u8>>,
}

struct State {
    endpoint: String,
    bucket: String,
    access: String,
    secret: String,
    sign_key: Rc<SigningKey>,
    device_vk: [u8; 32],
    x_secret: Rc<AgreementSecretKey>,
    x_pub: Vec<u8>,
    docs: HashMap<Vec<u8>, DocState>,
    adopted: HashMap<Vec<u8>, (EpochBlob, Vec<Vec<u8>>)>,
    shared_ctx: Option<SharedCtx>,
    texts: Vec<String>,
    fetches: u32,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> Result<R, String> {
    STATE.with(|s| {
        s.borrow_mut()
            .as_mut()
            .map(f)
            .ok_or_else(|| "not initialized".to_string())
    })
}

// --- small crypto helpers (all via polymorph:webcrypto) ---

async fn sha256(data: &[u8]) -> Result<Vec<u8>, String> {
    let digest = sha2::make_digest(Sha2Variant::Sha256).map_err(|e| format!("digest mint: {e}"))?;
    digest.compute(data).await.map_err(|e| format!("sha256: {e}"))
}

async fn hmac_key(raw: &[u8]) -> Result<Mac, String> {
    hmac_sha2::import_key_raw(
        Sha2Variant::Sha256,
        raw.to_vec(),
        MacKeyOptions {
            sign: true,
            verify: false,
            extractable: false,
        },
    )
    .await
    .map_err(|e| format!("hmac import: {e}"))
}

async fn hmac(raw_key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    hmac_key(raw_key)
        .await?
        .sign(data)
        .await
        .map_err(|e| format!("hmac sign: {e}"))
}

async fn aead_from_raw(raw: &[u8]) -> Result<Aead, String> {
    aes_gcm::import_key_raw(
        AesVariant::Aes256,
        raw.to_vec(),
        AeadKeyOptions {
            seal: true,
            open: true,
            wrap: false,
            unwrap: false,
            extractable: false,
        },
    )
    .await
    .map_err(|e| format!("aead import: {e}"))
}

async fn seal(aead: &Aead, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let nonce: [u8; 12] = rand::random();
    let ct = aead
        .seal(nonce.as_slice(), aad, plaintext)
        .await
        .map_err(|e| format!("seal: {e}"))?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ct);
    Ok(blob)
}

async fn open(aead: &Aead, aad: &[u8], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < 12 {
        return Err("blob too short".into());
    }
    let stream = aead
        .open(&blob[..12], aad, &blob[12..])
        .await
        .map_err(|e| format!("open: {e}"))?;
    Ok(stream.collect().await)
}

/// Pairwise derivations: HKDF over the X25519 shared secret, one purpose
/// per `info`.
async fn pairwise_input(
    secret: &AgreementSecretKey,
    peer_pub: &[u8],
    info: &str,
) -> Result<DeriveInput, String> {
    let peer = x25519::import_public_key_raw(peer_pub.to_vec())
        .await
        .map_err(|e| format!("x25519 import: {e}"))?;
    let agreed = secret
        .agree(&peer)
        .await
        .map_err(|e| format!("x25519 agree: {e}"))?;
    hkdf_sha2::prepare_from(Sha2Variant::Sha256, &agreed, "polymorph-storage-spike", info)
        .await
        .map_err(|e| format!("hkdf: {e}"))
}

async fn pairwise_mac(
    secret: &AgreementSecretKey,
    peer_pub: &[u8],
    info: &str,
) -> Result<Mac, String> {
    let input = pairwise_input(secret, peer_pub, info).await?;
    hmac_sha2::derive_key(
        Sha2Variant::Sha256,
        &input,
        None,
        MacKeyOptions {
            sign: true,
            verify: false,
            extractable: false,
        },
    )
    .await
    .map_err(|e| format!("derive mac: {e}"))
}

async fn pairwise_aead(
    secret: &AgreementSecretKey,
    peer_pub: &[u8],
    info: &str,
) -> Result<Aead, String> {
    let input = pairwise_input(secret, peer_pub, info).await?;
    aes_gcm::derive_key(
        AesVariant::Aes256,
        &input,
        AeadKeyOptions {
            seal: true,
            open: true,
            wrap: false,
            unwrap: false,
            extractable: false,
        },
    )
    .await
    .map_err(|e| format!("derive aead: {e}"))
}

// --- object names ---

async fn object_name(name_key: &[u8; 32], kind: &[u8], id: &[u8]) -> Result<String, String> {
    let mut data = kind.to_vec();
    data.extend_from_slice(id);
    Ok(hex::encode(hmac(name_key, &data).await?))
}

async fn kp_name(kp_loc: &Mac, doc: &[u8]) -> Result<String, String> {
    Ok(hex::encode(
        kp_loc.sign(doc).await.map_err(|e| format!("kp name: {e}"))?,
    ))
}

// --- SigV4 over the fetch import ---

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

struct Store {
    endpoint: String,
    bucket: String,
    access: String,
    secret: String,
}

fn store() -> Result<Store, String> {
    with_state(|s| Store {
        endpoint: s.endpoint.clone(),
        bucket: s.bucket.clone(),
        access: s.access.clone(),
        secret: s.secret.clone(),
    })
}

fn host_of(endpoint: &str) -> String {
    endpoint
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

async fn do_fetch(
    method: &str,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Result<(u16, Vec<u8>), String> {
    let _ = with_state(|s| s.fetches += 1);
    let resp = fetch::request(method.to_string(), url, headers, body)
        .await
        .map_err(|e| format!("fetch: {e}"))?;
    Ok((resp.status, resp.body))
}

/// A signed S3 request. `key` is the object key ("" for bucket ops);
/// `query` is the canonical query ("" or e.g. "policy=").
async fn s3_signed(
    st: &Store,
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

    let canonical_headers = format!(
        "host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz}\n"
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let scope = format!("{date}/us-east-1/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz}\n{scope}\n{}",
        hex::encode(sha256(canonical_request.as_bytes()).await?)
    );

    let mut key_material = format!("AWS4{}", st.secret).into_bytes();
    for step in [date.as_str(), "us-east-1", "s3", "aws4_request"] {
        key_material = hmac(&key_material, step.as_bytes()).await?;
    }
    let signature = hex::encode(hmac(&key_material, string_to_sign.as_bytes()).await?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        st.access
    );

    let url = if query.is_empty() {
        format!("{}{path}", st.endpoint)
    } else {
        format!("{}{path}?{}", st.endpoint, query.trim_end_matches('='))
    };
    do_fetch(
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

async fn put_object(st: &Store, key: &str, body: Vec<u8>) -> Result<(), String> {
    let (status, resp) = s3_signed(st, "PUT", key, "", body).await?;
    if status == 200 {
        Ok(())
    } else {
        Err(format!("PUT {key}: {status} {}", String::from_utf8_lossy(&resp)))
    }
}

async fn delete_object(st: &Store, key: &str) -> Result<(), String> {
    let (status, resp) = s3_signed(st, "DELETE", key, "", Vec::new()).await?;
    if status == 204 || status == 200 {
        Ok(())
    } else {
        Err(format!("DELETE {key}: {status} {}", String::from_utf8_lossy(&resp)))
    }
}

/// Unsigned GET: the account-less recipient path (availability by name
/// secrecy).
async fn get_object_unsigned(st: &Store, key: &str) -> Result<Option<Vec<u8>>, String> {
    let url = format!("{}/{}/{}", st.endpoint, st.bucket, key);
    let (status, body) = do_fetch("GET", url, Vec::new(), Vec::new()).await?;
    match status {
        200 => Ok(Some(body)),
        404 | 403 => Ok(None),
        other => Err(format!("GET {key}: {other}")),
    }
}

// --- manifests ---

async fn publish_manifest(st: &Store, doc: &[u8]) -> Result<(), String> {
    let (entries, name_key, device_vk, sign_key) = with_state(|s| {
        let d = s.docs.get(doc).expect("doc state");
        (
            d.entries.clone(),
            *d.name_keys.last().expect("epoch"),
            s.device_vk,
            s.sign_key.clone(),
        )
    })?;
    let manifest = Manifest {
        doc: doc.to_vec(),
        entries,
        device: device_vk,
    };
    let manifest_bytes = bincode::serialize(&manifest).map_err(|e| e.to_string())?;
    let sig = sign_key
        .sign(manifest_bytes.as_slice())
        .await
        .map_err(|e| format!("manifest sign: {e}"))?;
    let signed = bincode::serialize(&SignedManifest {
        manifest: manifest_bytes,
        sig,
    })
    .map_err(|e| e.to_string())?;
    let name = object_name(&name_key, b"manifest", &device_vk).await?;
    put_object(st, &name, signed).await
}

async fn fetch_manifest(
    st: &Store,
    name_key: &[u8; 32],
    device: &[u8],
) -> Result<Option<Manifest>, String> {
    let name = object_name(name_key, b"manifest", device).await?;
    let Some(blob) = get_object_unsigned(st, &name).await? else {
        return Ok(None);
    };
    let signed: SignedManifest = bincode::deserialize(&blob).map_err(|e| e.to_string())?;
    let vk = ed25519::import_verifying_key_raw(device.to_vec())
        .await
        .map_err(|e| format!("vk import: {e}"))?;
    vk.verify(signed.manifest.as_slice(), signed.sig.as_slice())
        .await
        .map_err(|_| "manifest signature invalid".to_string())?;
    let manifest: Manifest = bincode::deserialize(&signed.manifest).map_err(|e| e.to_string())?;
    Ok(Some(manifest))
}

/// Fetch and decrypt every readable chunk in entry order; the last
/// readable text wins.
async fn read_chunks(
    st: &Store,
    entries: &[([u8; 32], u32)],
    name_keys: &HashMap<u32, [u8; 32]>,
    content_keys: &HashMap<u32, Vec<u8>>,
) -> Result<DocView, String> {
    let mut text = String::new();
    let mut chunks_read = 0u32;
    for (cref, epoch) in entries {
        let (Some(nk), Some(ck)) = (name_keys.get(epoch), content_keys.get(epoch)) else {
            continue;
        };
        let name = object_name(nk, b"chunk", cref).await?;
        let Some(blob) = get_object_unsigned(st, &name).await? else {
            continue;
        };
        let aead = aead_from_raw(ck).await?;
        let plain = open(&aead, cref, &blob).await?;
        text = String::from_utf8_lossy(&plain).into_owned();
        chunks_read += 1;
    }
    Ok(DocView { text, chunks_read })
}

// --- per-recipient capability objects ---

async fn publish_recipient_objects(st: &Store, doc: &[u8], recipient: &[u8]) -> Result<(), String> {
    let (x_secret, name_keys, content_keys) = with_state(|s| {
        let d = s.docs.get(doc).expect("doc state");
        (
            s.x_secret.clone(),
            d.name_keys.clone(),
            d.content_keys.clone(),
        )
    })?;
    let current_nk = *name_keys.last().expect("epoch");

    // K_p: the name-key keychain at the pairwise-derived location.
    let kp_loc = pairwise_mac(&x_secret, recipient, "kp-location").await?;
    let kp_wrap = pairwise_aead(&x_secret, recipient, "kp-wrap").await?;
    let kp = KpBlob {
        epochs: name_keys
            .iter()
            .enumerate()
            .map(|(e, nk)| (e as u32, *nk))
            .collect(),
    };
    let kp_blob = seal(&kp_wrap, doc, &bincode::serialize(&kp).map_err(|e| e.to_string())?).await?;
    put_object(st, &kp_name(&kp_loc, doc).await?, kp_blob).await?;

    // readkeys: the content-key keychain, under the current name-key.
    let rk_wrap = pairwise_aead(&x_secret, recipient, "readkeys-wrap").await?;
    let rk = ReadKeys {
        epochs: content_keys
            .iter()
            .enumerate()
            .map(|(e, ck)| (e as u32, ck.clone()))
            .collect(),
    };
    let rk_blob = seal(&rk_wrap, doc, &bincode::serialize(&rk).map_err(|e| e.to_string())?).await?;
    let mut rk_id = b"readkeys".to_vec();
    rk_id.extend_from_slice(recipient);
    let rk_name = object_name(&current_nk, b"rk", &rk_id).await?;
    put_object(st, &rk_name, rk_blob).await
}

// --- the exported driver ---

struct Component;

impl Guest for Component {
    async fn init(
        endpoint: String,
        bucket: String,
        access_key: String,
        secret_key: String,
    ) -> Result<String, String> {
        let (sign_key, vk) = ed25519::generate_key(SigningKeyOptions {
            sign: true,
            extractable: false,
        })
        .await
        .map_err(|e| format!("ed25519: {e}"))?;
        let vk_raw = vk
            .export_key_raw()
            .await
            .map_err(|e| format!("vk export: {e}"))?;
        let device_vk: [u8; 32] = vk_raw
            .as_slice()
            .try_into()
            .map_err(|_| "vk not 32 bytes".to_string())?;

        // Worst-case soft identity: extractable, so the cracked image can
        // carry it (platforms with real key storage would refuse this).
        let (x_secret, x_pub) = x25519::generate_key(AgreementKeyOptions {
            derive_bits: false,
            derive_key: true,
            extractable: true,
        })
        .await
        .map_err(|e| format!("x25519: {e}"))?;
        let x_pub_raw = x_pub
            .export_key_raw()
            .await
            .map_err(|e| format!("x25519 pub export: {e}"))?;

        STATE.with(|s| {
            *s.borrow_mut() = Some(State {
                endpoint: endpoint.trim_end_matches('/').to_string(),
                bucket,
                access: access_key,
                secret: secret_key,
                sign_key: Rc::new(sign_key),
                device_vk,
                x_secret: Rc::new(x_secret),
                x_pub: x_pub_raw,
                docs: HashMap::new(),
                adopted: HashMap::new(),
                shared_ctx: None,
                texts: Vec::new(),
                fetches: 0,
            })
        });
        Ok(hex::encode(device_vk))
    }

    async fn x25519_pub() -> Result<Vec<u8>, String> {
        with_state(|s| s.x_pub.clone())
    }

    async fn ensure_bucket_public() -> Result<(), String> {
        let st = store()?;
        // An explicit location body: some servers reject a bodyless
        // CreateBucket arriving without a Content-Length.
        let create = br#"<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>us-east-1</LocationConstraint></CreateBucketConfiguration>"#.to_vec();
        let (status, resp) = s3_signed(&st, "PUT", "", "", create).await?;
        if status != 200 && status != 409 {
            return Err(format!(
                "create bucket: {status} {}",
                String::from_utf8_lossy(&resp)
            ));
        }
        let policy = format!(
            r#"{{"Version":"2012-10-17","Statement":[{{"Effect":"Allow","Principal":{{"AWS":["*"]}},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::{}/*"]}}]}}"#,
            st.bucket
        );
        let (status, resp) = s3_signed(&st, "PUT", "", "policy=", policy.into_bytes()).await?;
        if status == 200 || status == 204 {
            Ok(())
        } else {
            Err(format!(
                "put bucket policy: {status} {}",
                String::from_utf8_lossy(&resp)
            ))
        }
    }

    async fn create_doc() -> Result<Vec<u8>, String> {
        let doc: [u8; 32] = rand::random();
        let name_key: [u8; 32] = rand::random();
        let content_key: [u8; 32] = rand::random();
        with_state(|s| {
            s.docs.insert(
                doc.to_vec(),
                DocState {
                    name_keys: vec![name_key],
                    content_keys: vec![content_key.to_vec()],
                    entries: Vec::new(),
                    recipients: Vec::new(),
                },
            )
        })?;
        Ok(doc.to_vec())
    }

    async fn grant(doc: Vec<u8>, recipient_pub: Vec<u8>) -> Result<(), String> {
        let st = store()?;
        with_state(|s| {
            s.docs
                .get_mut(&doc)
                .map(|d| d.recipients.push(recipient_pub.clone()))
        })?
        .ok_or("unknown doc")?;
        publish_recipient_objects(&st, &doc, &recipient_pub).await
    }

    async fn author(doc: Vec<u8>, text: String) -> Result<String, String> {
        let st = store()?;
        let (name_key, content_key, epoch) = with_state(|s| {
            let d = s.docs.get(&doc).expect("doc state");
            (
                *d.name_keys.last().expect("epoch"),
                d.content_keys.last().expect("epoch").clone(),
                (d.name_keys.len() - 1) as u32,
            )
        })?;
        let cref: [u8; 32] = sha256(text.as_bytes())
            .await?
            .as_slice()
            .try_into()
            .map_err(|_| "cref".to_string())?;
        let aead = aead_from_raw(&content_key).await?;
        let blob = seal(&aead, &cref, text.as_bytes()).await?;
        put_object(&st, &object_name(&name_key, b"chunk", &cref).await?, blob).await?;
        with_state(|s| {
            s.docs
                .get_mut(&doc)
                .expect("doc state")
                .entries
                .push((cref, epoch))
        })?;
        publish_manifest(&st, &doc).await?;
        Ok(hex::encode(cref))
    }

    async fn export_epoch(doc: Vec<u8>) -> Result<Vec<u8>, String> {
        let blob = with_state(|s| {
            s.docs.get(&doc).map(|d| EpochBlob {
                name_keys: d
                    .name_keys
                    .iter()
                    .enumerate()
                    .map(|(e, nk)| (e as u32, *nk))
                    .collect(),
                content_keys: d
                    .content_keys
                    .iter()
                    .enumerate()
                    .map(|(e, ck)| (e as u32, ck.clone()))
                    .collect(),
            })
        })?
        .ok_or("unknown doc")?;
        bincode::serialize(&blob).map_err(|e| e.to_string())
    }

    async fn adopt_doc(
        doc: Vec<u8>,
        epoch_blob: Vec<u8>,
        author_devices: Vec<Vec<u8>>,
    ) -> Result<(), String> {
        let blob: EpochBlob = bincode::deserialize(&epoch_blob).map_err(|e| e.to_string())?;
        with_state(|s| s.adopted.insert(doc, (blob, author_devices)))?;
        Ok(())
    }

    async fn read_own(doc: Vec<u8>) -> Result<DocView, String> {
        let st = store()?;
        let (name_keys, content_keys, devices) = with_state(|s| {
            if let Some(d) = s.docs.get(&doc) {
                Some((
                    d.name_keys
                        .iter()
                        .enumerate()
                        .map(|(e, nk)| (e as u32, *nk))
                        .collect::<HashMap<_, _>>(),
                    d.content_keys
                        .iter()
                        .enumerate()
                        .map(|(e, ck)| (e as u32, ck.clone()))
                        .collect::<HashMap<_, _>>(),
                    vec![s.device_vk.to_vec()],
                ))
            } else {
                s.adopted.get(&doc).map(|(b, devs)| {
                    (
                        b.name_keys.iter().copied().collect(),
                        b.content_keys.iter().cloned().collect(),
                        devs.clone(),
                    )
                })
            }
        })?
        .ok_or("unknown doc")?;

        let current = *name_keys
            .iter()
            .max_by_key(|(e, _)| **e)
            .map(|(_, nk)| nk)
            .ok_or("no epochs")?;
        let mut entries: Vec<([u8; 32], u32)> = Vec::new();
        for dev in &devices {
            if let Some(m) = fetch_manifest(&st, &current, dev).await? {
                for e in m.entries {
                    if !entries.contains(&e) {
                        entries.push(e);
                    }
                }
            }
        }
        read_chunks(&st, &entries, &name_keys, &content_keys).await
    }

    async fn read_shared(
        doc: Vec<u8>,
        owner_pub: Vec<u8>,
        author_devices: Vec<Vec<u8>>,
    ) -> Result<DocView, String> {
        let st = store()?;
        let x_secret = with_state(|s| {
            s.shared_ctx = Some(SharedCtx {
                doc: doc.clone(),
                owner_pub: owner_pub.clone(),
                author_devs: author_devices.clone(),
            });
            s.x_secret.clone()
        })?;

        // Session-scoped pull-layer material: everything below is a local.
        let kp_loc = pairwise_mac(&x_secret, &owner_pub, "kp-location").await?;
        let kp_wrap = pairwise_aead(&x_secret, &owner_pub, "kp-wrap").await?;
        let kp_object = get_object_unsigned(&st, &kp_name(&kp_loc, &doc).await?)
            .await?
            .ok_or("kp missing (404): revoked or never granted")?;
        let kp: KpBlob = bincode::deserialize(&open(&kp_wrap, &doc, &kp_object).await?)
            .map_err(|e| format!("kp decode: {e}"))?;
        let name_keys: HashMap<u32, [u8; 32]> = kp.epochs.iter().copied().collect();
        let current = *name_keys
            .iter()
            .max_by_key(|(e, _)| **e)
            .map(|(_, nk)| nk)
            .ok_or("empty keychain")?;

        let rk_wrap = pairwise_aead(&x_secret, &owner_pub, "readkeys-wrap").await?;
        let my_pub = with_state(|s| s.x_pub.clone())?;
        let mut rk_id = b"readkeys".to_vec();
        rk_id.extend_from_slice(&my_pub);
        let rk_object = get_object_unsigned(&st, &object_name(&current, b"rk", &rk_id).await?)
            .await?
            .ok_or("readkeys missing")?;
        let rk: ReadKeys = bincode::deserialize(&open(&rk_wrap, &doc, &rk_object).await?)
            .map_err(|e| format!("readkeys decode: {e}"))?;
        let content_keys: HashMap<u32, Vec<u8>> = rk.epochs.iter().cloned().collect();

        let mut entries: Vec<([u8; 32], u32)> = Vec::new();
        for dev in &author_devices {
            if let Some(m) = fetch_manifest(&st, &current, dev).await? {
                for e in m.entries {
                    if !entries.contains(&e) {
                        entries.push(e);
                    }
                }
            }
        }
        let view = read_chunks(&st, &entries, &name_keys, &content_keys).await?;
        with_state(|s| s.texts.push(view.text.clone()))?;
        Ok(view)
    }

    async fn revoke(doc: Vec<u8>, recipient_pub: Vec<u8>) -> Result<(), String> {
        let st = store()?;
        let x_secret = with_state(|s| s.x_secret.clone())?;

        // Cooperative immediacy: the recipient's pickup object goes away.
        let kp_loc = pairwise_mac(&x_secret, &recipient_pub, "kp-location").await?;
        delete_object(&st, &kp_name(&kp_loc, &doc).await?).await?;

        // Hard forward boundary: rotate the epoch.
        let name_key: [u8; 32] = rand::random();
        let content_key: [u8; 32] = rand::random();
        let remaining = with_state(|s| {
            let d = s.docs.get_mut(&doc).expect("doc state");
            d.recipients.retain(|r| r != &recipient_pub);
            d.name_keys.push(name_key);
            d.content_keys.push(content_key.to_vec());
            d.recipients.clone()
        })?;
        publish_manifest(&st, &doc).await?;
        for recipient in remaining {
            publish_recipient_objects(&st, &doc, &recipient).await?;
        }
        Ok(())
    }

    async fn cracked_image() -> Result<Vec<u8>, String> {
        let (x_secret, x_pub, endpoint, bucket, shared, texts) = with_state(|s| {
            (
                s.x_secret.clone(),
                s.x_pub.clone(),
                s.endpoint.clone(),
                s.bucket.clone(),
                s.shared_ctx.clone(),
                s.texts.clone(),
            )
        })?;
        let jwk = x_secret
            .export_key_jwk()
            .await
            .map_err(|e| format!("x25519 export: {e}"))?;
        bincode::serialize(&CrackedImage {
            x25519_secret_jwk: jwk,
            x25519_pub: x_pub,
            endpoint,
            bucket,
            shared,
            texts,
        })
        .map_err(|e| e.to_string())
    }

    async fn import_image(image: Vec<u8>) -> Result<(), String> {
        let image: CrackedImage = bincode::deserialize(&image).map_err(|e| e.to_string())?;
        let x_secret = x25519::import_secret_key_jwk(
            image.x25519_secret_jwk,
            AgreementKeyOptions {
                derive_bits: false,
                derive_key: true,
                extractable: true,
            },
        )
        .await
        .map_err(|e| format!("x25519 import: {e}"))?;
        with_state(|s| {
            s.endpoint = image.endpoint;
            s.bucket = image.bucket;
            s.access = String::new();
            s.secret = String::new();
            s.x_secret = Rc::new(x_secret);
            s.x_pub = image.x25519_pub;
            s.shared_ctx = image.shared;
            s.texts = image.texts;
        })
    }

    async fn probe_put(name: String) -> Result<u16, String> {
        let st = store()?;
        let url = format!("{}/{}/{}", st.endpoint, st.bucket, name);
        let (status, _) = do_fetch("PUT", url, Vec::new(), b"junk".to_vec()).await?;
        Ok(status)
    }

    async fn probe_list() -> Result<u16, String> {
        let st = store()?;
        let url = format!("{}/{}/?list-type=2", st.endpoint, st.bucket);
        let (status, _) = do_fetch("GET", url, Vec::new(), Vec::new()).await?;
        Ok(status)
    }

    async fn stats() -> String {
        with_state(|s| format!("http requests: {}; texts fetched: {}", s.fetches, s.texts.len()))
            .unwrap_or_else(|e| e)
    }
}

export!(Component);
