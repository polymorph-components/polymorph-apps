//! Skeleton host, phase 3b: two engine instances (keyhive + subduction +
//! automerge + the subduction_keyhive bridge in one composite), the iroh
//! wire between them carrying BOTH protocols (an 'S' stream for
//! sedimentree sync, a 'K' stream for keyhive membership), and the pull
//! policy gated by the keyhive auth graph. The host shuttles nothing.
//!
//! Scenario: iroh wire up; contact cards travel over the bridge; Bob's
//! pull is REFUSED pre-membership; Alice adds Bob (Read) — membership
//! travels over the wire — Bob pulls and reads v1, then v2 via the
//! subscription; Alice revokes Bob and authors v3 — the pull gate closes
//! (does the ciphertext still reach a pre-existing subscriber? observed
//! and reported), the crypto layer stays closed regardless, and Alice
//! reads all three.

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

/// Wait for a sync task; the outcome (success or refusal) is scenario
/// data, not a host failure.
async fn wait_sync(acc: &Accessor<Ctx>, d: &Driver, handle: u32) -> Result<String> {
    for _ in 0..2000 {
        match d.call_sync_status(acc, handle).await? {
            Ok(Some(summary)) => return Ok(summary),
            Ok(None) => {}
            Err(e) => return Ok(format!("refused: {e}")),
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    bail!("sync task did not finish");
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

    // 2. The iroh wire: both protocols ride it; no host shuttling.
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
        bail!("authenticated peer mismatch");
    }
    println!("[{:>9.2?}] subduction handshake over iroh complete", t.elapsed());

    // 3. Contact cards travel over the bridge's K stream.
    let t = Instant::now();
    let mut known = false;
    for _ in 0..2000 {
        let a_knows = a
            .call_kh_knows_peer(acc, bob_id_bytes.clone())
            .await?
            .map_err(|e| format_err!("kh-knows-peer: {e}"))?;
        let b_knows = b
            .call_kh_knows_peer(acc, alice_id_bytes.clone())
            .await?
            .map_err(|e| format_err!("kh-knows-peer: {e}"))?;
        if a_knows && b_knows {
            known = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    if !known {
        bail!("contact cards did not propagate over the bridge");
    }
    println!(
        "[{:>9.2?}] contact cards exchanged over the keyhive bridge (no host shuttle)",
        t.elapsed()
    );

    // 4. Alice creates the shared doc — and Bob's pull is refused while he
    // is not a member.
    let created = step!(
        "alice.create-shared(v1, unsealed)",
        a.call_create_shared(acc, "hello from alice".into())
    );
    let doc_id = created.id.clone();

    let sync = step!(
        "bob.sync-start(alice, PRE-membership)",
        b.call_sync_start(acc, alice_id_bytes.clone(), doc_id.clone(), true)
    );
    let summary = wait_sync(acc, b, sync).await?;
    println!("            pre-membership sync outcome: {summary}");
    let commits_b = b
        .call_commits(acc, doc_id.clone())
        .await?
        .map_err(|e| format_err!("commits: {e}"))?;
    if !commits_b.is_empty() {
        bail!("PULL GATE FAILURE: bob obtained commits before membership");
    }
    println!("            bob has 0 commits: pull refused before membership");

    // 5. Alice adds Bob (Read) — membership travels over the wire — and
    // seals v1. Bob pulls and reads it.
    step!(
        "alice.kh-add-member(bob, Read)",
        a.call_kh_add_member(acc, doc_id.clone(), bob_id_bytes.clone())
    );
    let _v1 = step!(
        "alice.seal-initial(v1)",
        a.call_seal_initial(acc, doc_id.clone())
    );

    let t = Instant::now();
    let mut view = None;
    for _ in 0..600 {
        let sync = b
            .call_sync_start(acc, alice_id_bytes.clone(), doc_id.clone(), true)
            .await?
            .map_err(|e| format_err!("sync-start: {e}"))?;
        let _ = wait_sync(acc, b, sync).await?;
        match b.call_read_doc(acc, doc_id.clone()).await? {
            Ok(v) if v.chunks_read >= 1 && v.chunks_failed == 0 => {
                view = Some(v);
                break;
            }
            _ => {}
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let Some(view) = view else {
        bail!("bob never became able to read v1");
    };
    if view.text != "hello from alice" {
        bail!("bob's v1 view is wrong: {view:?}");
    }
    println!(
        "[{:>9.2?}] bob pulls and reads v1 (membership + epoch over the wire): {:?}",
        t.elapsed(),
        view.text
    );

    // 6. v2 via the live subscription.
    let v2 = step!(
        "alice.author-change(v2)",
        a.call_author_change(acc, doc_id.clone(), "hello again".into())
    );
    wait_commits(acc, b, &doc_id, &v2.content_ref, "v2 ciphertext reached bob via subscription").await?;
    let t = Instant::now();
    let mut ok = false;
    for _ in 0..600 {
        match b.call_read_doc(acc, doc_id.clone()).await? {
            Ok(v) if v.chunks_read == 2 && v.chunks_failed == 0 && v.text == "hello again" => {
                ok = true;
                break;
            }
            _ => {}
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    if !ok {
        bail!("bob never read v2");
    }
    println!("[{:>9.2?}] bob reads v2: \"hello again\"", t.elapsed());

    // 7. Revocation closes the pull gate; the crypto layer stays closed
    // regardless of delivery.
    step!(
        "alice.kh-revoke-member(bob)",
        a.call_kh_revoke_member(acc, doc_id.clone(), bob_id_bytes.clone())
    );
    let v3 = step!(
        "alice.author-change(v3, post-revocation)",
        a.call_author_change(acc, doc_id.clone(), "secret v3 (bob must not read)".into())
    );

    // Does the pre-existing subscription still deliver? Observe.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let commits_b = b
        .call_commits(acc, doc_id.clone())
        .await?
        .map_err(|e| format_err!("commits: {e}"))?;
    let pushed = commits_b.iter().any(|c| c == &v3.content_ref);
    if pushed {
        println!("            OBSERVED: v3 ciphertext still pushed to the revoked subscriber");
    } else {
        println!("            v3 ciphertext NOT pushed to the revoked subscriber");
    }

    // An explicit pull attempt must not obtain it either.
    let sync = step!(
        "bob.sync-start(alice, POST-revocation)",
        b.call_sync_start(acc, alice_id_bytes.clone(), doc_id.clone(), false)
    );
    let summary = wait_sync(acc, b, sync).await?;
    println!("            post-revocation sync outcome: {summary}");
    let commits_b = b
        .call_commits(acc, doc_id.clone())
        .await?
        .map_err(|e| format_err!("commits: {e}"))?;
    let has_v3 = commits_b.iter().any(|c| c == &v3.content_ref);

    let view = step!("bob.read-doc(post-revocation)", b.call_read_doc(acc, doc_id.clone()));
    if view.text != "hello again" {
        bail!("bob's readable text changed after revocation: {view:?}");
    }
    match (has_v3, view.chunks_failed) {
        (false, 0) => println!(
            "            pull gate held: no v3 bytes at bob; text still {:?}",
            view.text
        ),
        (true, 1) if view.chunks_read == 2 => println!(
            "            v3 bytes reached bob but decrypt refused ({}); text still {:?}",
            view.last_error.clone().unwrap_or_default(),
            view.text
        ),
        _ => bail!("unexpected post-revocation state: has_v3={has_v3}, view={view:?}"),
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
