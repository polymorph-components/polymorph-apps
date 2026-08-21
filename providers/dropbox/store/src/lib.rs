//! The Dropbox provider: the link-capability pull strategy.
//!
//! Ported from spikes/dropbox/guest/src/lib.rs (live-verified HTTP
//! shapes; the citations below point at that file). The delta vs S3 is
//! the pull tier only: names here are plain derivable paths and the pull
//! capability is a Dropbox shared link, which the provider revokes
//! server-side, hard and retroactively. Blob CONTENTS are identical to
//! the S3 path — same envelope bytes, same op-stream blob, same signed
//! manifest; only addressing and transport change.

use provider_common::{do_fetch, FetchPort, Route};

/// Consumer-Dropbox store config: ADDRESSING ONLY. App identifiers, the
/// user's bearer token and its refresh all live in the wired
/// `store-owner-fetch` instance; link-tier app auth lives in the wired
/// `store-shared-fetch` instance (#7). Tier is chosen by which import a
/// call site goes through, never by inspecting guest state for a token.
///
/// This is also the snapshot every call in this crate takes: there is no
/// token here and no app secret, so the guest cannot tell which
/// credential, if any, it is speaking with.
pub struct DbxCfg {
    pub root: String,
}

/// Owner-tier request: authority arrives from the WIRING, not from this
/// function. The guest sets no authorization header — the wired
/// `store-owner-fetch` instance injects the user's bearer at the seam and
/// owns token refresh, so an expired token never becomes guest business
/// (the old in-guest 401-refresh-retry moved behind the seam with the
/// token itself). A tierless or revoked instance refuses; its error
/// string surfaces through the normal error paths.
async fn bearer_fetch(
    _cfg: &DbxCfg,
    port: &impl FetchPort,
    url: &str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Result<(u16, Vec<u8>), String> {
    do_fetch(port, Route::Owner, "POST", url.to_string(), headers, body).await
}

/// A JSON-RPC call against api.dropboxapi.com over the owner route.
/// (spikes/dropbox/guest/src/lib.rs:326)
async fn dbx_rpc_raw(
    cfg: &DbxCfg,
    port: &impl FetchPort,
    endpoint: &str,
    body: serde_json::Value,
) -> Result<(u16, Vec<u8>), String> {
    bearer_fetch(
        cfg,
        port,
        &format!("https://api.dropboxapi.com/2/{endpoint}"),
        vec![("content-type".into(), "application/json".into())],
        body.to_string().into_bytes(),
    )
    .await
}

/// As `dbx_rpc_raw`, but 200 or bust. Dropbox's error bodies are JSON
/// carrying an `error_summary`, so they go into the error verbatim.
async fn dbx_rpc(
    cfg: &DbxCfg,
    port: &impl FetchPort,
    endpoint: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (status, resp) = dbx_rpc_raw(cfg, port, endpoint, body).await?;
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

/// Folder creation; an already-existing folder is a 409
/// `path/conflict/folder`, tolerated when asked.
pub async fn dbx_create_folder(
    cfg: &DbxCfg,
    port: &impl FetchPort,
    path: &str,
    tolerate_conflict: bool,
) -> Result<(), String> {
    let (status, resp) = dbx_rpc_raw(
        cfg,
        port,
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

pub async fn dbx_delete(cfg: &DbxCfg, port: &impl FetchPort, path: &str) -> Result<(), String> {
    dbx_rpc(
        cfg,
        port,
        "files/delete_v2",
        serde_json::json!({ "path": path }),
    )
    .await?;
    Ok(())
}

/// Mint a public shared link on `path` — the pull capability.
pub async fn dbx_mint_link(
    cfg: &DbxCfg,
    port: &impl FetchPort,
    path: &str,
) -> Result<String, String> {
    let (status, resp) = dbx_rpc_raw(
        cfg,
        port,
        "sharing/create_shared_link_with_settings",
        serde_json::json!({
            "path": path,
            "settings": { "requested_visibility": "public" },
        }),
    )
    .await?;
    if status == 200 {
        let value: serde_json::Value = serde_json::from_slice(&resp)
            .map_err(|e| format!("create_shared_link {path}: decode: {e}"))?;
        return value
            .get("url")
            .and_then(|u| u.as_str())
            .map(|u| u.to_string())
            .ok_or_else(|| format!("create_shared_link {path}: no url in response"));
    }
    // CONTRACT: the dispatch specifies minting only. A link already
    // minted on this path (409 shared_link_already_exists) can only
    // happen when a previous process left one behind — the state that
    // remembers it is per-instance. Adopting the existing link is the
    // conservative reading: erroring out would strand the doc, and
    // minting is not possible while one exists.
    let text = String::from_utf8_lossy(&resp);
    if status == 409 && text.contains("shared_link_already_exists") {
        let value = dbx_rpc(
            cfg,
            port,
            "sharing/list_shared_links",
            serde_json::json!({ "path": path, "direct_only": true }),
        )
        .await?;
        if let Some(url) = value
            .get("links")
            .and_then(|l| l.as_array())
            .and_then(|l| l.first())
            .and_then(|l| l.get("url"))
            .and_then(|u| u.as_str())
        {
            return Ok(url.to_string());
        }
    }
    Err(format!("create_shared_link {path}: {status} {text}"))
}

/// Hard, retroactive, server-side revocation of a link.
pub async fn dbx_revoke_link(
    cfg: &DbxCfg,
    port: &impl FetchPort,
    url: &str,
) -> Result<(), String> {
    dbx_rpc(
        cfg,
        port,
        "sharing/revoke_shared_link",
        serde_json::json!({ "url": url }),
    )
    .await?;
    Ok(())
}

/// Owner write: path-addressed, overwrite-in-place, implicit parents.
pub async fn dbx_upload(
    cfg: &DbxCfg,
    port: &impl FetchPort,
    path: &str,
    body: Vec<u8>,
) -> Result<(), String> {
    let (status, resp) = bearer_fetch(
        cfg,
        port,
        "https://content.dropboxapi.com/2/files/upload",
        vec![
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
/// refused" on content endpoints, and is reported as absence.
async fn dbx_download(
    cfg: &DbxCfg,
    port: &impl FetchPort,
    path: &str,
) -> Result<Option<Vec<u8>>, String> {
    let (status, body) = bearer_fetch(
        cfg,
        port,
        "https://content.dropboxapi.com/2/files/download",
        vec![(
            "dropbox-api-arg".into(),
            serde_json::json!({ "path": path }).to_string(),
        )],
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

/// Owner list: the doc folder's entry names, following `has_more`.
/// Doc folders are small, but the continue loop is the correct shape.
pub async fn dbx_list_folder(
    cfg: &DbxCfg,
    port: &impl FetchPort,
    folder: &str,
) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    let (status, resp) = dbx_rpc_raw(
        cfg,
        port,
        "files/list_folder",
        serde_json::json!({ "path": folder }),
    )
    .await?;
    let text = String::from_utf8_lossy(&resp);
    // A doc nothing has been flushed for yet: no folder, no devices.
    if status == 409 && text.contains("not_found") {
        return Ok(names);
    }
    if status != 200 {
        return Err(format!("files/list_folder: {status} {text}"));
    }
    let mut value: serde_json::Value =
        serde_json::from_slice(&resp).map_err(|e| format!("files/list_folder: decode: {e}"))?;
    loop {
        if let Some(entries) = value.get("entries").and_then(|e| e.as_array()) {
            for entry in entries {
                if let Some(name) = entry.get("name").and_then(|n| n.as_str()) {
                    names.push(name.to_string());
                }
            }
        }
        let more = value
            .get("has_more")
            .and_then(|m| m.as_bool())
            .unwrap_or(false);
        let cursor = value
            .get("cursor")
            .and_then(|c| c.as_str())
            .map(|c| c.to_string());
        match (more, cursor) {
            (true, Some(cursor)) => {
                value = dbx_rpc(
                    cfg,
                    port,
                    "files/list_folder/continue",
                    serde_json::json!({ "cursor": cursor }),
                )
                .await?;
            }
            _ => break,
        }
    }
    Ok(names)
}

/// The link-tier recipient's read: a shared-link fetch mediated by app
/// auth alone. 409 means refused — which is what revocation produces,
/// indistinguishable from "never existed" (no existence oracle).
///
/// Routed Shared — the APP tier, which is neither of the other two.
/// Dropbox will not serve a shared link to an unauthenticated caller, so
/// this cannot be Public; but the identity it demands is the app key and
/// secret that every shipped client embeds, which are public identifiers
/// and not the user, so it must not be Owner either. Sending it through
/// its own import is what makes the anonymity property STRUCTURAL: a
/// recipient-path read cannot identify the user because the user's
/// credential is wired somewhere else entirely. (This is the memo's live
/// near-miss — owner, link, and anonymous calls all address the same
/// host, so attaching credentials by destination would deanonymize
/// exactly this path.)
///
/// The guest sends no authorization header; the wired instance injects
/// app-auth at the seam.
pub async fn dbx_link_fetch(
    cfg: &DbxCfg,
    port: &impl FetchPort,
    url: &str,
    rel: Option<&str>,
) -> Result<Option<Vec<u8>>, String> {
    let _ = cfg;
    let arg = match rel {
        Some(path) => serde_json::json!({ "url": url, "path": path }),
        None => serde_json::json!({ "url": url }),
    };
    let (status, body) = do_fetch(
        port,
        Route::Shared,
        "POST",
        "https://content.dropboxapi.com/2/sharing/get_shared_link_file".into(),
        vec![("dropbox-api-arg".into(), arg.to_string())],
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

// Paths: plain and client-derivable — no name secrecy on this provider,
// so no name-key epochs either.

pub fn dbx_doc_folder(root: &str, doc: &[u8]) -> String {
    format!("/{root}/docs/{}", hex::encode(doc))
}

/// `chunk-{cref}` / `oplog-{device}` / `manifest-{device}`.
pub fn dbx_child(kind: &str, id: &[u8]) -> String {
    format!("{kind}-{}", hex::encode(id))
}

pub fn dbx_pickup_path(root: &str, doc: &[u8], member: &[u8]) -> String {
    format!(
        "/{root}/pickup/{}/{}",
        hex::encode(doc),
        hex::encode(member)
    )
}

/// The two ways to reach a doc's objects: as the owner (Bearer, by
/// path) or as a link-tier recipient (app auth, by relative path under
/// the container link).
pub enum DbxSource {
    Owner(String),
    Link(String),
}

pub async fn dbx_fetch_child(
    cfg: &DbxCfg,
    port: &impl FetchPort,
    src: &DbxSource,
    name: &str,
) -> Result<Option<Vec<u8>>, String> {
    match src {
        DbxSource::Owner(folder) => dbx_download(cfg, port, &format!("{folder}/{name}")).await,
        DbxSource::Link(url) => dbx_link_fetch(cfg, port, url, Some(&format!("/{name}"))).await,
    }
}
