//! Skeleton host: two engine instances (keyhive + subduction + automerge in
//! one composite), the iroh wire between them, the host shuttling only
//! keyhive membership events (phase 3a scope).
//!
//! Scenario: contact exchange; iroh wire + subduction handshake; Alice
//! creates a shared automerge doc (encrypted under the keyhive doc group)
//! and adds Bob; Bob syncs ciphertext and reads v1; Alice authors v2, the
//! subscription pushes it, Bob reads v2; Alice revokes Bob and authors v3 —
//! Bob still RECEIVES the v3 ciphertext (pull) but cannot READ it
//! (KeyNotFound), while Alice reads all three. Pull and read, separated by
//! cryptography rather than delivery.

use std::path::PathBuf;
use std::time::Instant;

use polymorph_webcrypto_wasmtime::{WasiWebcryptoCtx, WasiWebcryptoCtxView, WasiWebcryptoView};
use wasmtime::component::{Accessor, Component, HasData, Linker, ResourceTable};
use wasmtime::error::Context as _;
use wasmtime::{bail, format_err, Config, Engine, Result, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_webrtc_datachannels::{self as webrtc_host, WebrtcCtx, WebrtcCtxView, WebrtcView};
use wasmtime_websocket::{WasiWebsocketCtx, WasiWebsocketCtxView, WasiWebsocketView};

mod bindings {
    wasmtime::component::bindgen!({
        path: "../guest/wit",
        world: "spike",
        imports: {
            default: async | store | trappable,
        },
        exports: {
            default: async,
        },
    });
}

use bindings::exports::polymorph::skeleton_spike::driver::Guest as Driver;

struct Ctx {
    wasi: WasiCtx,
    webcrypto: WasiWebcryptoCtx,
    websocket: WasiWebsocketCtx,
    webrtc: WebrtcCtx,
    table: ResourceTable,
}

impl HasData for Ctx {
    type Data<'a> = &'a mut Self;
}

impl WasiView for Ctx {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiWebcryptoView for Ctx {
    fn webcrypto(&mut self) -> WasiWebcryptoCtxView<'_> {
        WasiWebcryptoCtxView {
            ctx: &mut self.webcrypto,
            table: &mut self.table,
        }
    }
}

impl WasiWebsocketView for Ctx {
    fn websocket(&mut self) -> WasiWebsocketCtxView<'_> {
        WasiWebsocketCtxView {
            ctx: &mut self.websocket,
            table: &mut self.table,
        }
    }
}

impl WebrtcView for Ctx {
    fn webrtc(&mut self) -> WebrtcCtxView<'_> {
        WebrtcCtxView {
            ctx: &mut self.webrtc,
            table: &mut self.table,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/composed.wasm"));
    let mut relay = "http://127.0.0.1:3340".to_string();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--relay" => relay = args.next().ok_or_else(|| format_err!("--relay needs a URL"))?,
            other => bail!("unknown argument {other}"),
        }
    }

    let mut config = Config::new();
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    let engine = Engine::new(&config)?;

    let component = Component::from_file(&engine, &path)
        .with_context(|| format!("loading component {}", path.display()))?;

    let mut linker: Linker<Ctx> = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    polymorph_webcrypto_wasmtime::add_to_linker(&mut linker)?;
    wasmtime_websocket::add_to_linker(&mut linker)?;
    webrtc_host::add_to_linker(&mut linker)?;

    let mut store = Store::new(
        &engine,
        Ctx {
            wasi: WasiCtxBuilder::new().inherit_stdout().inherit_stderr().build(),
            webcrypto: WasiWebcryptoCtx::new(),
            websocket: WasiWebsocketCtx::new(),
            webrtc: WebrtcCtx::new(),
            table: ResourceTable::new(),
        },
    );

    let t0 = Instant::now();
    let alice = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let bob = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    println!("[{:>9.2?}] instantiated Alice + Bob", t0.elapsed());

    store
        .run_concurrent(async move |acc| scenario(acc, alice, bob, relay).await)
        .await?
}

macro_rules! step {
    ($label:expr, $call:expr) => {{
        let t = Instant::now();
        let out = $call
            .await?
            .map_err(|e| format_err!("{}: {e}", $label))?;
        println!("[{:>9.2?}] {}", t.elapsed(), $label);
        out
    }};
}

/// Shuttle Alice's keyhive events to Bob (host-mediated in 3a), plus any
/// CGKA update events an encryption produced.
async fn shuttle_kh(
    acc: &Accessor<Ctx>,
    a: &Driver,
    b: &Driver,
    bob_id: &[u8],
    update: &Option<Vec<u8>>,
    label: &str,
) -> Result<()> {
    let events = a
        .call_kh_events_for_peer(acc, bob_id.to_vec())
        .await?
        .map_err(|e| format_err!("kh-events-for-peer: {e}"))?;
    let stuck = b
        .call_kh_ingest_events(acc, events)
        .await?
        .map_err(|e| format_err!("kh-ingest: {e}"))?;
    if let Some(update) = update {
        let _ = b
            .call_kh_ingest_events(acc, update.clone())
            .await?
            .map_err(|e| format_err!("kh-ingest(update): {e}"))?;
    }
    println!("            kh events shuttled ({label}), stuck={stuck}");
    Ok(())
}

async fn wait_commits(
    acc: &Accessor<Ctx>,
    d: &Driver,
    tree: &[u8],
    want: &[u8],
    what: &str,
) -> Result<()> {
    let t = Instant::now();
    for _ in 0..2000 {
        let commits = d
            .call_commits(acc, tree.to_vec())
            .await?
            .map_err(|e| format_err!("commits: {e}"))?;
        if commits.iter().any(|c| c == want) {
            println!("[{:>9.2?}] {what}", t.elapsed());
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    bail!("{what}: commit did not arrive");
}

async fn scenario(
    acc: &Accessor<Ctx>,
    alice: bindings::Spike,
    bob: bindings::Spike,
    relay: String,
) -> Result<()> {
    let a: &Driver = alice.polymorph_skeleton_spike_driver();
    let b: &Driver = bob.polymorph_skeleton_spike_driver();

    // 1. One identity per peer, backing keyhive AND subduction.
    let alice_id = step!("alice.init (one webcrypto identity, both layers)", a.call_init(acc));
    let bob_id = step!("bob.init   (one webcrypto identity, both layers)", b.call_init(acc));
    println!("            alice={alice_id}");
    println!("            bob  ={bob_id}");
    let alice_id_bytes = hex::decode(&alice_id).map_err(|e| format_err!("{e}"))?;
    let bob_id_bytes = hex::decode(&bob_id).map_err(|e| format_err!("{e}"))?;

    // 2. Keyhive contact exchange (host-shuttled, 3a scope).
    let bob_card = step!("bob.contact-card", b.call_contact_card(acc));
    let seen = step!(
        "alice.receive-contact-card(bob)",
        a.call_receive_contact_card(acc, bob_card)
    );
    if seen != bob_id {
        bail!("contact card mismatch");
    }

    // 3. The iroh wire + subduction handshake.
    let _a_ep = step!("alice.iroh-bind", a.call_iroh_bind(acc, relay.clone()));
    let b_ep = step!("bob.iroh-bind", b.call_iroh_bind(acc, relay.clone()));
    let b_ep_bytes = hex::decode(&b_ep).map_err(|e| format_err!("{e}"))?;
    let cb = step!(
        "bob.iroh-start(acceptor)",
        b.call_iroh_start(acc, false, vec![], relay.clone(), vec![])
    );
    let ca = step!(
        "alice.iroh-start(initiator)",
        a.call_iroh_start(acc, true, b_ep_bytes, relay.clone(), bob_id_bytes.clone())
    );
    let t = Instant::now();
    let (mut a_peer, mut b_peer) = (None, None);
    for _ in 0..2000 {
        if a_peer.is_none() {
            a_peer = a
                .call_conn_status(acc, ca)
                .await?
                .map_err(|e| format_err!("alice handshake: {e}"))?;
        }
        if b_peer.is_none() {
            b_peer = b
                .call_conn_status(acc, cb)
                .await?
                .map_err(|e| format_err!("bob handshake: {e}"))?;
        }
        if a_peer.is_some() && b_peer.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    let (Some(a_peer), Some(b_peer)) = (a_peer, b_peer) else {
        bail!("subduction handshake over iroh did not complete");
    };
    if a_peer != bob_id || b_peer != alice_id {
        bail!("authenticated peer mismatch: alice saw {a_peer}, bob saw {b_peer}");
    }
    println!("[{:>9.2?}] subduction handshake over iroh complete", t.elapsed());

    // 4. Alice creates the shared doc and adds Bob.
    let created = step!(
        "alice.create-shared(v1, unsealed)",
        a.call_create_shared(acc, "hello from alice".into())
    );
    let doc_id = created.id.clone();
    step!(
        "alice.kh-add-member(bob, Read)",
        a.call_kh_add_member(acc, doc_id.clone(), bob_id_bytes.clone())
    );
    shuttle_kh(acc, a, b, &bob_id_bytes, &None, "membership").await?;
    let v1 = step!(
        "alice.seal-initial(v1)",
        a.call_seal_initial(acc, doc_id.clone())
    );
    shuttle_kh(acc, a, b, &bob_id_bytes, &v1.update_events, "v1 epoch").await?;

    // 5. Bob syncs the ciphertext and reads v1.
    let sync = step!(
        "bob.sync-start(alice, subscribe)",
        b.call_sync_start(acc, alice_id_bytes.clone(), doc_id.clone(), true)
    );
    let t = Instant::now();
    let mut summary = None;
    for _ in 0..2000 {
        summary = b
            .call_sync_status(acc, sync)
            .await?
            .map_err(|e| format_err!("bob sync: {e}"))?;
        if summary.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    let Some(summary) = summary else {
        bail!("bob's sync did not complete");
    };
    println!("[{:>9.2?}] bob sync complete: {summary}", t.elapsed());

    let view = step!("bob.read-doc(v1)", b.call_read_doc(acc, doc_id.clone()));
    if view.text != "hello from alice" || view.chunks_read != 1 || view.chunks_failed != 0 {
        bail!("bob's v1 view is wrong: {view:?}");
    }
    println!("            bob reads: {:?}", view.text);

    // 6. Alice authors v2; the subscription pushes it; Bob reads it.
    let v2 = step!(
        "alice.author-change(v2)",
        a.call_author_change(acc, doc_id.clone(), "hello again".into())
    );
    shuttle_kh(acc, a, b, &bob_id_bytes, &v2.update_events, "v2 epoch").await?;
    wait_commits(acc, b, &doc_id, &v2.content_ref, "v2 ciphertext reached bob via subscription").await?;
    let view = step!("bob.read-doc(v2)", b.call_read_doc(acc, doc_id.clone()));
    if view.text != "hello again" || view.chunks_read != 2 || view.chunks_failed != 0 {
        bail!("bob's v2 view is wrong: {view:?}");
    }
    println!("            bob reads: {:?}", view.text);

    // 7. Revoke Bob; Alice authors v3. Bob gets the BYTES (pull) but not
    // the CONTENT (read) — adversarial full delivery of the keyhive events
    // included.
    step!(
        "alice.kh-revoke-member(bob)",
        a.call_kh_revoke_member(acc, doc_id.clone(), bob_id_bytes.clone())
    );
    let v3 = step!(
        "alice.author-change(v3, post-revocation)",
        a.call_author_change(acc, doc_id.clone(), "secret v3 (bob must not read)".into())
    );
    shuttle_kh(acc, a, b, &bob_id_bytes, &v3.update_events, "revocation + v3 epoch").await?;
    wait_commits(acc, b, &doc_id, &v3.content_ref, "v3 CIPHERTEXT reached bob (pull still works)").await?;

    let view = step!("bob.read-doc(post-revocation)", b.call_read_doc(acc, doc_id.clone()));
    if view.chunks_read != 2 || view.chunks_failed != 1 {
        bail!("bob's post-revocation view is wrong: {view:?}");
    }
    if view.text != "hello again" {
        bail!("bob's readable text changed after revocation: {view:?}");
    }
    let err = view.last_error.clone().unwrap_or_default();
    println!(
        "            bob: read {} chunks, {} refused ({}), text still {:?}",
        view.chunks_read, view.chunks_failed, err, view.text
    );
    if !err.contains("KeyNotFound") {
        bail!("expected KeyNotFound, got: {err}");
    }

    // 8. Alice reads everything.
    let view = step!("alice.read-doc", a.call_read_doc(acc, doc_id.clone()));
    if view.text != "secret v3 (bob must not read)" || view.chunks_read != 3 {
        bail!("alice's view is wrong: {view:?}");
    }
    println!("            alice reads: {:?}", view.text);

    let a_stats = a.call_stats(acc).await?;
    let b_stats = b.call_stats(acc).await?;
    println!("\nalice: {a_stats}");
    println!("bob:   {b_stats}");
    println!("\nSPIKE PASSED");
    Ok(())
}
