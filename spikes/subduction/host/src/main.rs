//! Spike host: instantiates the guest twice (Alice, Bob) in one store,
//! serves `polymorph:webcrypto` + WASI p2, and acts as the dumb wire —
//! draining each instance's outbox into the other's inbox — while the
//! real subduction handshake and sync protocol run inside the guests.
//!
//! Scenario: handshake over shuttled frames; Alice commits v1; Bob syncs
//! and converges (commit + blob); Bob commits v2 (child of v1); Alice
//! converges via subscription push or an explicit sync round (which one
//! happened is reported).

use std::path::PathBuf;
use std::time::Instant;

use polymorph_webcrypto_wasmtime::{WasiWebcryptoCtx, WasiWebcryptoCtxView, WasiWebcryptoView};
use wasmtime::component::{Accessor, Component, HasData, Linker, ResourceTable};
use wasmtime::error::Context as _;
use wasmtime::{bail, format_err, Config, Engine, Result, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

mod bindings {
    wasmtime::component::bindgen!({
        path: "../guest/wit",
        world: "spike",
        exports: {
            default: async,
        },
    });
}

use bindings::exports::polymorph::subduction_spike::driver::Guest as Driver;

struct Ctx {
    wasi: WasiCtx,
    webcrypto: WasiWebcryptoCtx,
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

#[tokio::main]
async fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/wasm32-wasip2/release/spike_guest.wasm"));

    let mut config = Config::new();
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    let engine = Engine::new(&config)?;

    let component = Component::from_file(&engine, &path)
        .with_context(|| format!("loading component {}", path.display()))?;

    let mut linker: Linker<Ctx> = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    polymorph_webcrypto_wasmtime::add_to_linker(&mut linker)?;

    let mut store = Store::new(
        &engine,
        Ctx {
            wasi: WasiCtxBuilder::new().inherit_stdout().inherit_stderr().build(),
            webcrypto: WasiWebcryptoCtx::new(),
            table: ResourceTable::new(),
        },
    );

    let t0 = Instant::now();
    let alice = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let bob = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    println!("[{:>9.2?}] instantiated Alice + Bob", t0.elapsed());

    store
        .run_concurrent(async move |acc| scenario(acc, alice, bob).await)
        .await?
}

/// Await a guest call, unwrap its `result<_, string>`, print a timing row.
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

/// One pump round: drain A→B and B→A. Returns how many frames moved.
async fn pump(
    acc: &Accessor<Ctx>,
    a: &Driver,
    b: &Driver,
    ca: u32,
    cb: u32,
) -> Result<usize> {
    let mut moved = 0;
    let out_a = a
        .call_outbox(acc, ca)
        .await?
        .map_err(|e| format_err!("alice.outbox: {e}"))?;
    moved += out_a.len();
    if !out_a.is_empty() {
        b.call_deliver(acc, cb, out_a)
            .await?
            .map_err(|e| format_err!("bob.deliver: {e}"))?;
    }
    let out_b = b
        .call_outbox(acc, cb)
        .await?
        .map_err(|e| format_err!("bob.outbox: {e}"))?;
    moved += out_b.len();
    if !out_b.is_empty() {
        a.call_deliver(acc, ca, out_b)
            .await?
            .map_err(|e| format_err!("alice.deliver: {e}"))?;
    }
    Ok(moved)
}

async fn scenario(acc: &Accessor<Ctx>, alice: bindings::Spike, bob: bindings::Spike) -> Result<()> {
    let a: &Driver = alice.polymorph_subduction_spike_driver();
    let b: &Driver = bob.polymorph_subduction_spike_driver();

    // 1. Identities.
    let alice_id = step!("alice.init (webcrypto identity + subduction)", a.call_init(acc));
    let bob_id = step!("bob.init   (webcrypto identity + subduction)", b.call_init(acc));
    println!("            alice={alice_id}");
    println!("            bob  ={bob_id}");
    let alice_id_bytes = hex::decode(&alice_id).map_err(|e| format_err!("{e}"))?;
    let bob_id_bytes = hex::decode(&bob_id).map_err(|e| format_err!("{e}"))?;

    // 2. Handshake over the shuttle (real challenge/response frames).
    let ca = step!(
        "alice.open-conn(initiator)",
        a.call_open_conn(acc, true, bob_id_bytes.clone())
    );
    let cb = step!(
        "bob.open-conn(responder)",
        b.call_open_conn(acc, false, alice_id_bytes.clone())
    );

    let t = Instant::now();
    let mut a_peer = None;
    let mut b_peer = None;
    let mut rounds = 0;
    let mut frames = 0;
    for _ in 0..200 {
        rounds += 1;
        frames += pump(acc, a, b, ca, cb).await?;
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
    }
    let (Some(a_peer), Some(b_peer)) = (a_peer, b_peer) else {
        bail!("handshake did not complete in {rounds} pump rounds");
    };
    println!(
        "[{:>9.2?}] handshake complete in {rounds} pump rounds ({frames} frames)",
        t.elapsed()
    );
    if a_peer != bob_id || b_peer != alice_id {
        bail!("authenticated peer mismatch: alice saw {a_peer}, bob saw {b_peer}");
    }

    // 3. Alice commits v1; Bob syncs and converges.
    let tree = vec![7u8; 32];
    let v1: &[u8] = b"subduction spike v1";
    let h1 = step!(
        "alice.add-commit(v1)",
        a.call_add_commit(acc, tree.clone(), vec![], v1.to_vec())
    );

    let sync1 = step!(
        "bob.sync-start(alice, subscribe)",
        b.call_sync_start(acc, alice_id_bytes.clone(), tree.clone(), true)
    );
    let t = Instant::now();
    let mut summary = None;
    let mut rounds = 0;
    for _ in 0..500 {
        rounds += 1;
        pump(acc, a, b, ca, cb).await?;
        summary = b
            .call_sync_status(acc, sync1)
            .await?
            .map_err(|e| format_err!("bob sync: {e}"))?;
        if summary.is_some() {
            break;
        }
    }
    let Some(summary) = summary else {
        bail!("sync did not complete in {rounds} pump rounds");
    };
    println!(
        "[{:>9.2?}] bob sync complete in {rounds} pump rounds: {summary}",
        t.elapsed()
    );

    let commits_b = step!("bob.commits", b.call_commits(acc, tree.clone()));
    if !commits_b.contains(&h1) {
        bail!("bob is missing alice's commit after sync");
    }
    let blob = step!("bob.blob-of(v1)", b.call_blob_of(acc, tree.clone(), h1.clone()));
    if blob != v1 {
        bail!("bob stored wrong blob for v1");
    }
    println!("            bob converged on v1: OK");

    // 4. Bob commits v2 (child of v1); does subscription push it to Alice?
    let v2: &[u8] = b"subduction spike v2";
    let h2 = step!(
        "bob.add-commit(v2, parent v1)",
        b.call_add_commit(acc, tree.clone(), vec![h1.clone()], v2.to_vec())
    );

    let t = Instant::now();
    let mut pushed = false;
    for _ in 0..100 {
        pump(acc, a, b, ca, cb).await?;
        let commits_a = a
            .call_commits(acc, tree.clone())
            .await?
            .map_err(|e| format_err!("alice.commits: {e}"))?;
        if commits_a.contains(&h2) {
            pushed = true;
            break;
        }
    }
    if pushed {
        println!(
            "[{:>9.2?}] v2 reached alice via subscription push",
            t.elapsed()
        );
    } else {
        println!(
            "[{:>9.2?}] no subscription push observed; falling back to explicit sync",
            t.elapsed()
        );
        let sync2 = step!(
            "alice.sync-start(bob)",
            a.call_sync_start(acc, bob_id_bytes.clone(), tree.clone(), false)
        );
        let mut summary = None;
        for _ in 0..500 {
            pump(acc, a, b, ca, cb).await?;
            summary = a
                .call_sync_status(acc, sync2)
                .await?
                .map_err(|e| format_err!("alice sync: {e}"))?;
            if summary.is_some() {
                break;
            }
        }
        let Some(summary) = summary else {
            bail!("alice's sync round did not complete");
        };
        println!("            alice sync: {summary}");
    }

    let commits_a = step!("alice.commits", a.call_commits(acc, tree.clone()));
    if !commits_a.contains(&h2) {
        bail!("alice is missing bob's commit");
    }
    let blob = step!(
        "alice.blob-of(v2)",
        a.call_blob_of(acc, tree.clone(), h2.clone())
    );
    if blob != v2 {
        bail!("alice stored wrong blob for v2");
    }
    println!("            alice converged on v2: OK");

    let a_stats = a.call_stats(acc).await?;
    let b_stats = b.call_stats(acc).await?;
    println!("\nalice: {a_stats}");
    println!("bob:   {b_stats}");
    println!("\nSPIKE PASSED");
    Ok(())
}
