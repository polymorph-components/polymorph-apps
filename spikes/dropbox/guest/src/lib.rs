//! The Dropbox-spike guest: the dumb-store contract implemented over the
//! consumer Dropbox API, exercising the *link-capability* pull strategy.
//!
//! The strategy delta vs the S3 spike (spikes/storage) is the pull tier.
//! There, availability rested on name secrecy: HMAC-derived object names
//! and cooperative deletion of the pickup object. Here, names are plain
//! derivable paths and the pull capability is a Dropbox *shared link* —
//! which the provider revokes server-side, hard and retroactively. That
//! is what lets this spike assert something the S3 shape cannot: a
//! maximally dishonest client that hoarded the container link still goes
//! dark after revocation.
//!
//! HTTP arrives through the composed `polymorph:fetchspike/fetch` import
//! (a separate component wrapping wasip3's wasi:http@0.3 client). All
//! crypto goes through polymorph:webcrypto: pairwise capabilities are
//! X25519+HKDF, content sealing is AES-256-GCM, manifests are
//! Ed25519-signed, crefs are SHA-256.
//!
//! Owner writes authenticate with `Authorization: Bearer {access-token}`.
//! Account-less recipients hold no token at all: their shared-link fetches
//! carry only app auth (Basic app-key:app-secret), the anonymous-fetch
//! mediator — public identifiers that ship inside any real client.
//!
//! The no-persist discipline is structural in `read-shared`: every piece
//! of resolved link material is a function-local, dropped on return —
//! with ONE deliberate, labeled exception (the hoarded doc link), which
//! exists precisely so the revocation assertions are made against the
//! worst case.

wit_bindgen::generate!({
    path: "wit",
    world: "spike",
    generate_all,
});

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use base64::Engine as _;
use polymorph_webcrypto_guest::{
    aes_gcm::{self, AesVariant},
    ed25519, hkdf_sha2,
    sha2::{self, Sha2Variant},
    x25519, Aead, AeadKeyOptions, AgreementKeyOptions, AgreementSecretKey, DeriveInput, SigningKey,
    SigningKeyOptions,
};
use serde::{Deserialize, Serialize};

use exports::polymorph::dropbox_spike::driver::{DocView, Guest};
use polymorph::fetchspike::fetch;

// --- serialized formats ---

/// The per-recipient pickup object: the current container capability plus
/// the epoch it was minted at. Sealed pairwise ("pickup-wrap"), rewritten
/// in place on rotation — the recipient's own file link keeps serving it
/// (probe P8), so their standing capability never changes.
#[derive(Serialize, Deserialize)]
struct PickupBlob {
    doc_link: String,
    epoch: u32,
}

#[derive(Serialize, Deserialize)]
struct ReadKeys {
    /// (epoch, content-key) keychain — spike stand-in for keyhive's op
    /// stream.
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

/// Device-group stand-in: no name-keys in this provider, so the whole
/// export is the content keychain.
#[derive(Serialize, Deserialize)]
struct ExportBlob {
    content_keys: Vec<(u32, Vec<u8>)>,
}

#[derive(Serialize, Deserialize, Clone)]
struct SharedCtx {
    doc: Vec<u8>,
    owner_pub: Vec<u8>,
    author_devs: Vec<Vec<u8>>,
}

/// Everything a worst-case client image contains: the soft identity
/// secret, config (app key/secret are public identifiers shipped in any
/// client — the *access token* is not in here, an account-less recipient
/// never had one), the standing pickup link, the HOARDED doc link, and
/// every plaintext the client ever fetched.
#[derive(Serialize, Deserialize)]
struct CrackedImage {
    x25519_secret_jwk: String,
    x25519_pub: Vec<u8>,
    root: String,
    app_key: String,
    app_secret: String,
    pickup_link: Option<String>,
    hoarded_doc_link: Option<String>,
    shared: Option<SharedCtx>,
    texts: Vec<String>,
}

// --- instance state ---

struct DocState {
    content_keys: Vec<Vec<u8>>,
    entries: Vec<([u8; 32], u32)>,
    /// (recipient x25519 pub, that recipient's standing pickup link).
    recipients: Vec<(Vec<u8>, String)>,
    /// The container capability currently minted on the doc folder.
    doc_link: String,
}

struct State {
    root: String,
    app_key: String,
    app_secret: String,
    token: String,
    sign_key: Rc<SigningKey>,
    device_vk: [u8; 32],
    x_secret: Rc<AgreementSecretKey>,
    x_pub: Vec<u8>,
    docs: HashMap<Vec<u8>, DocState>,
    adopted: HashMap<Vec<u8>, (ExportBlob, Vec<Vec<u8>>)>,
    shared_ctx: Option<SharedCtx>,
    /// The recipient's standing capability (kept: it IS the honest
    /// client's persisted state, the analogue of a bookmark).
    pickup_link: Option<String>,
    /// DELIBERATE no-persist violation, see `read_shared`.
    hoarded_doc_link: Option<String>,
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
/// per `info`. Only two purposes exist in this provider — "pickup-wrap"
/// and "readkeys-wrap". (The S3 spike's third, "kp-location", has no
/// analogue: locations here are plain paths and links, not secrets.)
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
    hkdf_sha2::prepare_from(Sha2Variant::Sha256, &agreed, "polymorph-dropbox-spike", info)
        .await
        .map_err(|e| format!("hkdf: {e}"))
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

// --- paths (plain and derivable: no name secrecy in this strategy) ---

fn doc_folder(root: &str, doc: &[u8]) -> String {
    format!("/{root}/docs/{}", hex::encode(doc))
}

fn chunk_name(cref: &[u8]) -> String {
    format!("chunk-{}", hex::encode(cref))
}

fn manifest_name(device: &[u8]) -> String {
    format!("manifest-{}", hex::encode(device))
}

fn readkeys_name(recipient: &[u8]) -> String {
    format!("readkeys-{}", hex::encode(recipient))
}

fn pickup_path(root: &str, doc: &[u8], recipient: &[u8]) -> String {
    format!(
        "/{root}/pickup/{}/{}",
        hex::encode(doc),
        hex::encode(recipient)
    )
}

// --- the Dropbox API over the fetch import ---

struct Cfg {
    root: String,
    app_key: String,
    app_secret: String,
    token: String,
}

fn cfg() -> Result<Cfg, String> {
    with_state(|s| Cfg {
        root: s.root.clone(),
        app_key: s.app_key.clone(),
        app_secret: s.app_secret.clone(),
        token: s.token.clone(),
    })
}

impl Cfg {
    fn bearer(&self) -> String {
        format!("Bearer {}", self.token)
    }

    /// App auth: the account-less recipient's only credential. These are
    /// public identifiers baked into a shipped client, which is exactly
    /// why the design cannot lean on them for confidentiality.
    fn basic(&self) -> String {
        let raw = format!("{}:{}", self.app_key, self.app_secret);
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(raw)
        )
    }
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

/// A JSON-RPC call against api.dropboxapi.com with the owner's token.
async fn rpc_raw(
    cfg: &Cfg,
    endpoint: &str,
    body: serde_json::Value,
) -> Result<(u16, Vec<u8>), String> {
    do_fetch(
        "POST",
        format!("https://api.dropboxapi.com/2/{endpoint}"),
        vec![
            ("authorization".into(), cfg.bearer()),
            ("content-type".into(), "application/json".into()),
        ],
        body.to_string().into_bytes(),
    )
    .await
}

/// As `rpc_raw`, but 200 or bust; Dropbox's error bodies are JSON with an
/// `error_summary`, so they go into the error string verbatim.
async fn rpc(
    cfg: &Cfg,
    endpoint: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (status, resp) = rpc_raw(cfg, endpoint, body).await?;
    if status != 200 {
        return Err(format!(
            "{endpoint}: {status} {}",
            String::from_utf8_lossy(&resp)
        ));
    }
    if resp.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(&resp).map_err(|e| format!("{endpoint}: decode response: {e}"))
}

/// Folder creation. Parents are tolerated as already-existing (409
/// `path/conflict/folder`) when `tolerate_conflict` is set.
async fn create_folder(cfg: &Cfg, path: &str, tolerate_conflict: bool) -> Result<(), String> {
    let (status, resp) = rpc_raw(
        cfg,
        "files/create_folder_v2",
        serde_json::json!({ "path": path, "autorename": false }),
    )
    .await?;
    let text = String::from_utf8_lossy(&resp);
    if status == 200 || (tolerate_conflict && status == 409 && text.contains("conflict")) {
        Ok(())
    } else {
        Err(format!("create_folder_v2 {path}: {status} {text}"))
    }
}

async fn delete_path(cfg: &Cfg, path: &str) -> Result<(), String> {
    rpc(cfg, "files/delete_v2", serde_json::json!({ "path": path })).await?;
    Ok(())
}

/// Mint a public shared link on `path` — the pull capability. Returns the
/// URL.
async fn mint_link(cfg: &Cfg, path: &str) -> Result<String, String> {
    let value = rpc(
        cfg,
        "sharing/create_shared_link_with_settings",
        serde_json::json!({
            "path": path,
            "settings": { "requested_visibility": "public" },
        }),
    )
    .await?;
    value
        .get("url")
        .and_then(|u| u.as_str())
        .map(|u| u.to_string())
        .ok_or_else(|| format!("create_shared_link {path}: no url in response"))
}

/// Hard, retroactive, server-side revocation of a link (probe P4).
async fn revoke_link(cfg: &Cfg, url: &str) -> Result<(), String> {
    rpc(
        cfg,
        "sharing/revoke_shared_link",
        serde_json::json!({ "url": url }),
    )
    .await?;
    Ok(())
}

/// Owner write: path-addressed, overwrite-in-place, implicit parents.
async fn upload(cfg: &Cfg, path: &str, body: Vec<u8>) -> Result<(), String> {
    let (status, resp) = do_fetch(
        "POST",
        "https://content.dropboxapi.com/2/files/upload".into(),
        vec![
            ("authorization".into(), cfg.bearer()),
            ("content-type".into(), "application/octet-stream".into()),
            (
                "dropbox-api-arg".into(),
                serde_json::json!({ "path": path, "mode": "overwrite" }).to_string(),
            ),
        ],
        body,
    )
    .await?;
    if status == 200 {
        Ok(())
    } else {
        Err(format!(
            "upload {path}: {status} {}",
            String::from_utf8_lossy(&resp)
        ))
    }
}

/// Owner read: Bearer download by path. 409 is Dropbox's "not found /
/// refused" for content endpoints, and is reported as absence.
async fn download(cfg: &Cfg, path: &str) -> Result<Option<Vec<u8>>, String> {
    let (status, body) = do_fetch(
        "POST",
        "https://content.dropboxapi.com/2/files/download".into(),
        vec![
            ("authorization".into(), cfg.bearer()),
            (
                "dropbox-api-arg".into(),
                serde_json::json!({ "path": path }).to_string(),
            ),
        ],
        Vec::new(),
    )
    .await?;
    match status {
        200 => Ok(Some(body)),
        409 => Ok(None),
        other => Err(format!(
            "download {path}: {other} {}",
            String::from_utf8_lossy(&body)
        )),
    }
}

/// The account-less recipient's read: a shared-link fetch mediated by app
/// auth alone. `rel` addresses a child under a *folder* link. 409 means
/// refused — which is exactly what revocation produces, indistinguishable
/// from "never existed" (no existence oracle, probe P3).
async fn link_fetch(cfg: &Cfg, url: &str, rel: Option<&str>) -> Result<Option<Vec<u8>>, String> {
    let arg = match rel {
        Some(path) => serde_json::json!({ "url": url, "path": path }),
        None => serde_json::json!({ "url": url }),
    };
    let (status, body) = do_fetch(
        "POST",
        "https://content.dropboxapi.com/2/sharing/get_shared_link_file".into(),
        vec![
            ("authorization".into(), cfg.basic()),
            ("dropbox-api-arg".into(), arg.to_string()),
        ],
        Vec::new(),
    )
    .await?;
    match status {
        200 => Ok(Some(body)),
        409 => Ok(None),
        other => Err(format!(
            "shared-link fetch: {other} {}",
            String::from_utf8_lossy(&body)
        )),
    }
}

// --- reading, over either tier ---

/// The two ways to reach a doc's objects: as the owner (Bearer, by path)
/// or as a recipient (app-auth, by relative path under the folder link).
/// Everything above this line is tier-specific; everything below is not.
enum Source {
    Owner(String),
    Link(String),
}

async fn fetch_child(cfg: &Cfg, src: &Source, name: &str) -> Result<Option<Vec<u8>>, String> {
    match src {
        Source::Owner(folder) => download(cfg, &format!("{folder}/{name}")).await,
        Source::Link(url) => link_fetch(cfg, url, Some(&format!("/{name}"))).await,
    }
}

async fn fetch_manifest(
    cfg: &Cfg,
    src: &Source,
    device: &[u8],
) -> Result<Option<Manifest>, String> {
    let Some(blob) = fetch_child(cfg, src, &manifest_name(device)).await? else {
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

/// Merge every author device's signed entry list, append-ordered.
async fn merge_entries(
    cfg: &Cfg,
    src: &Source,
    devices: &[Vec<u8>],
) -> Result<Vec<([u8; 32], u32)>, String> {
    let mut entries: Vec<([u8; 32], u32)> = Vec::new();
    for dev in devices {
        if let Some(m) = fetch_manifest(cfg, src, dev).await? {
            for e in m.entries {
                if !entries.contains(&e) {
                    entries.push(e);
                }
            }
        }
    }
    Ok(entries)
}

/// Fetch and decrypt every readable chunk in entry order; the last
/// readable text wins. Entries sealed under an epoch this reader has no
/// key for are simply skipped — that is the forward boundary.
async fn read_chunks(
    cfg: &Cfg,
    src: &Source,
    entries: &[([u8; 32], u32)],
    content_keys: &HashMap<u32, Vec<u8>>,
) -> Result<DocView, String> {
    let mut text = String::new();
    let mut chunks_read = 0u32;
    for (cref, epoch) in entries {
        let Some(ck) = content_keys.get(epoch) else {
            continue;
        };
        let Some(blob) = fetch_child(cfg, src, &chunk_name(cref)).await? else {
            continue;
        };
        let aead = aead_from_raw(ck).await?;
        let plain = open(&aead, cref, &blob).await?;
        text = String::from_utf8_lossy(&plain).into_owned();
        chunks_read += 1;
    }
    Ok(DocView { text, chunks_read })
}

/// The recipient half of a read, given a resolved container link:
/// readkeys -> manifests -> chunks. `Ok(None)` means the link itself
/// refused us (409) — revoked, or never ours.
async fn read_via_doc_link(
    cfg: &Cfg,
    doc: &[u8],
    doc_link: &str,
    owner_pub: &[u8],
    author_devices: &[Vec<u8>],
) -> Result<Option<DocView>, String> {
    let (x_secret, my_pub) = with_state(|s| (s.x_secret.clone(), s.x_pub.clone()))?;
    let Some(rk_blob) = link_fetch(cfg, doc_link, Some(&format!("/{}", readkeys_name(&my_pub))))
        .await?
    else {
        return Ok(None);
    };
    let rk_wrap = pairwise_aead(&x_secret, owner_pub, "readkeys-wrap").await?;
    let rk: ReadKeys = bincode::deserialize(&open(&rk_wrap, doc, &rk_blob).await?)
        .map_err(|e| format!("readkeys decode: {e}"))?;
    let content_keys: HashMap<u32, Vec<u8>> = rk.epochs.iter().cloned().collect();

    let src = Source::Link(doc_link.to_string());
    let entries = merge_entries(cfg, &src, author_devices).await?;
    Ok(Some(read_chunks(cfg, &src, &entries, &content_keys).await?))
}

// --- publishing ---

async fn publish_manifest(cfg: &Cfg, doc: &[u8]) -> Result<(), String> {
    let (entries, device_vk, sign_key) = with_state(|s| {
        let d = s.docs.get(doc).expect("doc state");
        (d.entries.clone(), s.device_vk, s.sign_key.clone())
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
    // Stable path, overwrite-in-place: the manifest never moves, so the
    // container link keeps serving it across rotations.
    let path = format!(
        "{}/{}",
        doc_folder(&cfg.root, doc),
        manifest_name(&device_vk)
    );
    upload(cfg, &path, signed).await
}

/// The recipient's readkeys object: the whole content keychain, sealed
/// pairwise, at a plain per-recipient path inside the doc folder.
async fn publish_readkeys(cfg: &Cfg, doc: &[u8], recipient: &[u8]) -> Result<(), String> {
    let (x_secret, content_keys) = with_state(|s| {
        let d = s.docs.get(doc).expect("doc state");
        (s.x_secret.clone(), d.content_keys.clone())
    })?;
    let rk_wrap = pairwise_aead(&x_secret, recipient, "readkeys-wrap").await?;
    let rk = ReadKeys {
        epochs: content_keys
            .iter()
            .enumerate()
            .map(|(e, ck)| (e as u32, ck.clone()))
            .collect(),
    };
    let blob = seal(
        &rk_wrap,
        doc,
        &bincode::serialize(&rk).map_err(|e| e.to_string())?,
    )
    .await?;
    let path = format!(
        "{}/{}",
        doc_folder(&cfg.root, doc),
        readkeys_name(recipient)
    );
    upload(cfg, &path, blob).await
}

/// The recipient's pickup object: the current container link, sealed
/// pairwise, written at a *stable* path. On rotation this is overwritten
/// in place, so the recipient's standing file link serves the new content
/// without a new capability ever being delivered (probe P8).
async fn publish_pickup(cfg: &Cfg, doc: &[u8], recipient: &[u8]) -> Result<(), String> {
    let (x_secret, doc_link, epoch) = with_state(|s| {
        let d = s.docs.get(doc).expect("doc state");
        (
            s.x_secret.clone(),
            d.doc_link.clone(),
            (d.content_keys.len() - 1) as u32,
        )
    })?;
    let wrap = pairwise_aead(&x_secret, recipient, "pickup-wrap").await?;
    let blob = seal(
        &wrap,
        doc,
        &bincode::serialize(&PickupBlob { doc_link, epoch }).map_err(|e| e.to_string())?,
    )
    .await?;
    upload(cfg, &pickup_path(&cfg.root, doc, recipient), blob).await
}

// --- the exported driver ---

struct Component;

impl Guest for Component {
    async fn init(
        root: String,
        app_key: String,
        app_secret: String,
        access_token: String,
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
                root: root.trim_matches('/').to_string(),
                app_key,
                app_secret,
                // Empty = an account-less recipient: shared-link fetches
                // with app auth alone, no write path at all.
                token: access_token,
                sign_key: Rc::new(sign_key),
                device_vk,
                x_secret: Rc::new(x_secret),
                x_pub: x_pub_raw,
                docs: HashMap::new(),
                adopted: HashMap::new(),
                shared_ctx: None,
                pickup_link: None,
                hoarded_doc_link: None,
                texts: Vec::new(),
                fetches: 0,
            })
        });
        Ok(hex::encode(device_vk))
    }

    async fn x25519_pub() -> Result<Vec<u8>, String> {
        with_state(|s| s.x_pub.clone())
    }

    async fn create_doc() -> Result<Vec<u8>, String> {
        let cfg = cfg()?;
        let doc: [u8; 32] = rand::random();
        let content_key: [u8; 32] = rand::random();

        // Uploads create parents implicitly, but the container link must
        // be minted on the FOLDER — which therefore has to exist first,
        // before any file lands in it. Only this folder needs explicit
        // creation; the pickup folder is created implicitly by the first
        // pickup upload, and its links are minted on files.
        create_folder(&cfg, &format!("/{}", cfg.root), true).await?;
        create_folder(&cfg, &format!("/{}/docs", cfg.root), true).await?;
        let folder = doc_folder(&cfg.root, &doc);
        create_folder(&cfg, &folder, false).await?;
        let doc_link = mint_link(&cfg, &folder).await?;

        with_state(|s| {
            s.docs.insert(
                doc.to_vec(),
                DocState {
                    content_keys: vec![content_key.to_vec()],
                    entries: Vec::new(),
                    recipients: Vec::new(),
                    doc_link,
                },
            )
        })?;
        Ok(doc.to_vec())
    }

    async fn grant(doc: Vec<u8>, recipient_pub: Vec<u8>) -> Result<String, String> {
        let cfg = cfg()?;
        with_state(|s| s.docs.contains_key(&doc))?
            .then_some(())
            .ok_or("unknown doc")?;
        publish_readkeys(&cfg, &doc, &recipient_pub).await?;
        publish_pickup(&cfg, &doc, &recipient_pub).await?;
        // The pickup FILE now exists, so its own link can be minted: the
        // recipient's standing capability, delivered here by the host in
        // lieu of the E2E contact channel.
        let link = mint_link(&cfg, &pickup_path(&cfg.root, &doc, &recipient_pub)).await?;
        with_state(|s| {
            s.docs
                .get_mut(&doc)
                .expect("doc state")
                .recipients
                .push((recipient_pub.clone(), link.clone()))
        })?;
        Ok(link)
    }

    async fn author(doc: Vec<u8>, text: String) -> Result<String, String> {
        let cfg = cfg()?;
        let (content_key, epoch) = with_state(|s| {
            let d = s.docs.get(&doc).expect("doc state");
            (
                d.content_keys.last().expect("epoch").clone(),
                (d.content_keys.len() - 1) as u32,
            )
        })?;
        let cref: [u8; 32] = sha256(text.as_bytes())
            .await?
            .as_slice()
            .try_into()
            .map_err(|_| "cref".to_string())?;
        let aead = aead_from_raw(&content_key).await?;
        let blob = seal(&aead, &cref, text.as_bytes()).await?;
        let path = format!("{}/{}", doc_folder(&cfg.root, &doc), chunk_name(&cref));
        upload(&cfg, &path, blob).await?;
        with_state(|s| {
            s.docs
                .get_mut(&doc)
                .expect("doc state")
                .entries
                .push((cref, epoch))
        })?;
        publish_manifest(&cfg, &doc).await?;
        Ok(hex::encode(cref))
    }

    async fn export_doc(doc: Vec<u8>) -> Result<Vec<u8>, String> {
        let blob = with_state(|s| {
            s.docs.get(&doc).map(|d| ExportBlob {
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
        blob: Vec<u8>,
        author_devices: Vec<Vec<u8>>,
    ) -> Result<(), String> {
        let blob: ExportBlob = bincode::deserialize(&blob).map_err(|e| e.to_string())?;
        with_state(|s| s.adopted.insert(doc, (blob, author_devices)))?;
        Ok(())
    }

    async fn read_own(doc: Vec<u8>) -> Result<DocView, String> {
        let cfg = cfg()?;
        let (content_keys, devices) = with_state(|s| {
            if let Some(d) = s.docs.get(&doc) {
                Some((
                    d.content_keys
                        .iter()
                        .enumerate()
                        .map(|(e, ck)| (e as u32, ck.clone()))
                        .collect::<HashMap<_, _>>(),
                    vec![s.device_vk.to_vec()],
                ))
            } else {
                s.adopted.get(&doc).map(|(b, devs)| {
                    (b.content_keys.iter().cloned().collect(), devs.clone())
                })
            }
        })?
        .ok_or("unknown doc")?;

        // Owner tier: Bearer downloads by path. The pull tier (links) is
        // not involved at all — which is why an owner device rides a
        // revocation without noticing it.
        let src = Source::Owner(doc_folder(&cfg.root, &doc));
        let entries = merge_entries(&cfg, &src, &devices).await?;
        read_chunks(&cfg, &src, &entries, &content_keys).await
    }

    async fn read_shared(
        doc: Vec<u8>,
        pickup_link: String,
        owner_pub: Vec<u8>,
        author_devices: Vec<Vec<u8>>,
    ) -> Result<DocView, String> {
        let cfg = cfg()?;
        let x_secret = with_state(|s| s.x_secret.clone())?;

        let Some(blob) = link_fetch(&cfg, &pickup_link, None).await? else {
            return Err("pickup link refused (409): revoked or never granted".into());
        };
        let wrap = pairwise_aead(&x_secret, &owner_pub, "pickup-wrap").await?;
        let pickup: PickupBlob = bincode::deserialize(&open(&wrap, &doc, &blob).await?)
            .map_err(|e| format!("pickup decode: {e}"))?;

        // DELIBERATE no-persist violation, labeled: an honest client would
        // drop the resolved container link with the rest of the session's
        // link material. We hoard it so `cracked-image` models the
        // maximally dishonest client, and the revocation assertions have
        // to hold against THAT. Everything else resolved below stays a
        // function-local.
        with_state(|s| s.hoarded_doc_link = Some(pickup.doc_link.clone()))?;

        let view = read_via_doc_link(&cfg, &doc, &pickup.doc_link, &owner_pub, &author_devices)
            .await?
            .ok_or("doc link refused (409): revoked")?;

        with_state(|s| {
            s.shared_ctx = Some(SharedCtx {
                doc: doc.clone(),
                owner_pub: owner_pub.clone(),
                author_devs: author_devices.clone(),
            });
            s.pickup_link = Some(pickup_link.clone());
            s.texts.push(view.text.clone());
        })?;
        Ok(view)
    }

    async fn revoke(doc: Vec<u8>, recipient_pub: Vec<u8>) -> Result<(), String> {
        let cfg = cfg()?;
        let (their_link, doc_link) = with_state(|s| {
            let d = s.docs.get(&doc).expect("doc state");
            (
                d.recipients
                    .iter()
                    .find(|(r, _)| r == &recipient_pub)
                    .map(|(_, l)| l.clone()),
                d.doc_link.clone(),
            )
        })?;
        let their_link = their_link.ok_or("unknown recipient")?;

        // 1. Their standing capability dies, and the object behind it goes
        //    away too.
        revoke_link(&cfg, &their_link).await?;
        delete_path(&cfg, &pickup_path(&cfg.root, &doc, &recipient_pub)).await?;
        delete_path(
            &cfg,
            &format!(
                "{}/{}",
                doc_folder(&cfg.root, &doc),
                readkeys_name(&recipient_pub)
            ),
        )
        .await?;

        // 2. The hard boundary this whole strategy exists for: revoking
        //    the container link kills pull-now AND pull-past, server-side,
        //    against arbitrarily modified clients — including one holding
        //    a hoarded copy of this exact URL.
        revoke_link(&cfg, &doc_link).await?;

        // 3. Pull-forward: a FRESH link on the SAME folder. Zero data
        //    movement, no re-encryption, no compaction (probe P4).
        let folder = doc_folder(&cfg.root, &doc);
        let new_link = mint_link(&cfg, &folder).await?;

        let content_key: [u8; 32] = rand::random();
        let remaining = with_state(|s| {
            let d = s.docs.get_mut(&doc).expect("doc state");
            d.recipients.retain(|(r, _)| r != &recipient_pub);
            d.content_keys.push(content_key.to_vec());
            d.doc_link = new_link;
            d.recipients.clone()
        })?;

        // 4. Remaining recipients ride the rotation in place: their pickup
        //    objects are overwritten with the new link, and their own
        //    file links — untouched — keep serving.
        for (recipient, _link) in remaining {
            publish_readkeys(&cfg, &doc, &recipient).await?;
            publish_pickup(&cfg, &doc, &recipient).await?;
        }
        Ok(())
    }

    async fn cracked_image() -> Result<Vec<u8>, String> {
        let (x_secret, x_pub, root, app_key, app_secret, pickup_link, hoarded, shared, texts) =
            with_state(|s| {
                (
                    s.x_secret.clone(),
                    s.x_pub.clone(),
                    s.root.clone(),
                    s.app_key.clone(),
                    s.app_secret.clone(),
                    s.pickup_link.clone(),
                    s.hoarded_doc_link.clone(),
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
            root,
            app_key,
            app_secret,
            pickup_link,
            hoarded_doc_link: hoarded,
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
            s.root = image.root;
            // App key/secret travel in the image because they are public
            // identifiers in any shipped client. The access token does
            // not: an account-less recipient never held one.
            s.app_key = image.app_key;
            s.app_secret = image.app_secret;
            s.token = String::new();
            s.x_secret = Rc::new(x_secret);
            s.x_pub = image.x25519_pub;
            s.pickup_link = image.pickup_link;
            s.hoarded_doc_link = image.hoarded_doc_link;
            s.shared_ctx = image.shared;
            s.texts = image.texts;
        })
    }

    async fn read_cracked() -> Result<DocView, String> {
        let cfg = cfg()?;
        let (shared, pickup_link, hoarded, x_secret) = with_state(|s| {
            (
                s.shared_ctx.clone(),
                s.pickup_link.clone(),
                s.hoarded_doc_link.clone(),
                s.x_secret.clone(),
            )
        })?;
        let shared = shared.ok_or("no shared context in image")?;
        let pickup_link = pickup_link.ok_or("no pickup link in image")?;

        // Attempt 1: the standing capability, exactly as the stock client
        // would use it.
        if let Some(blob) = link_fetch(&cfg, &pickup_link, None).await? {
            let wrap = pairwise_aead(&x_secret, &shared.owner_pub, "pickup-wrap").await?;
            let pickup: PickupBlob = bincode::deserialize(&open(&wrap, &shared.doc, &blob).await?)
                .map_err(|e| format!("pickup decode: {e}"))?;
            if let Some(view) = read_via_doc_link(
                &cfg,
                &shared.doc,
                &pickup.doc_link,
                &shared.owner_pub,
                &shared.author_devs,
            )
            .await?
            {
                return Ok(view);
            }
            return Err("pickup link resolved but doc link refused (409)".into());
        }

        // Attempt 2: the hoard — the thing a modified client kept that it
        // was never supposed to. Under the S3 name-secrecy strategy the
        // equivalent hoard would still work; here the server refuses it.
        let Some(doc_link) = hoarded else {
            // CONTRACT: the WIT and the dispatch only specify the wording
            // for the both-refused case; this branch cannot arise in the
            // scenario (read-shared always hoards before an image is
            // taken), so it is worded honestly rather than forced to
            // match the assertion substrings.
            return Err(
                "pickup link refused (409); no hoarded doc link in image".into(),
            );
        };
        match read_via_doc_link(
            &cfg,
            &shared.doc,
            &doc_link,
            &shared.owner_pub,
            &shared.author_devs,
        )
        .await?
        {
            Some(view) => Ok(view),
            None => Err(
                "pickup link refused (409); hoarded doc link refused (409): revoked server-side"
                    .into(),
            ),
        }
    }

    async fn probe_noauth(link: String) -> Result<u16, String> {
        let (status, _) = do_fetch(
            "POST",
            "https://content.dropboxapi.com/2/sharing/get_shared_link_file".into(),
            vec![(
                "dropbox-api-arg".into(),
                serde_json::json!({ "url": link }).to_string(),
            )],
            Vec::new(),
        )
        .await?;
        Ok(status)
    }

    async fn probe_write(name: String) -> Result<u16, String> {
        let cfg = cfg()?;
        // App auth instead of the owner's Bearer token: writes are
        // owner-token-only, so this must be refused. The path stays under
        // this run's root so `cleanup` covers it if it ever succeeds.
        let (status, _) = do_fetch(
            "POST",
            "https://content.dropboxapi.com/2/files/upload".into(),
            vec![
                ("authorization".into(), cfg.basic()),
                ("content-type".into(), "application/octet-stream".into()),
                (
                    "dropbox-api-arg".into(),
                    serde_json::json!({
                        "path": format!("/{}/{name}", cfg.root),
                        "mode": "overwrite",
                    })
                    .to_string(),
                ),
            ],
            b"junk".to_vec(),
        )
        .await?;
        Ok(status)
    }

    async fn cleanup() -> Result<(), String> {
        let cfg = cfg()?;
        delete_path(&cfg, &format!("/{}", cfg.root)).await
    }

    async fn stats() -> String {
        with_state(|s| format!("http requests: {}; texts fetched: {}", s.fetches, s.texts.len()))
            .unwrap_or_else(|e| e)
    }
}

export!(Component);
