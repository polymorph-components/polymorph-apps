//! Spike host: instantiates the guest component twice (Alice, Bob) in one
//! store, serves `polymorph:webcrypto` (RustCrypto) plus WASI p2, and acts
//! as the dumb channel — shuttling opaque blobs between the instances and
//! asserting the scenario:
//!
//! 1. identities via webcrypto (non-extractable), contact-card exchange
//! 2. Alice creates a doc, adds Bob (Read), sends events
//! 3. Alice encrypts v1; Bob decrypts it
//! 4. Alice revokes Bob, encrypts v2; Bob gets *everything* (adversarial
//!    delivery) and must still fail to decrypt v2 — exclusion is
//!    cryptographic, not delivery-dependent
//! 5. Bob can still decrypt v1 (causal keys: history stays readable)
//! 6. Alice archives + restores with the same platform-held signer, then
//!    keeps working (encrypts v3)

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

use bindings::exports::polymorph::keyhive_spike::driver::Guest as Driver;

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
            wasi: WasiCtxBuilder::new().build(),
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

async fn scenario(
    acc: &Accessor<Ctx>,
    alice: bindings::Spike,
    bob: bindings::Spike,
) -> Result<()> {
    let a: &Driver = alice.polymorph_keyhive_spike_driver();
    let b: &Driver = bob.polymorph_keyhive_spike_driver();

    // 1. Identities + contact exchange.
    let alice_id = step!("alice.init (webcrypto identity + keyhive)", a.call_init(acc));
    let bob_id = step!("bob.init   (webcrypto identity + keyhive)", b.call_init(acc));
    println!("            alice={alice_id}");
    println!("            bob  ={bob_id}");

    let bob_card = step!("bob.contact-card", b.call_contact_card(acc));
    let seen = step!(
        "alice.receive-contact-card(bob)",
        a.call_receive_contact_card(acc, bob_card)
    );
    if seen != bob_id {
        bail!("contact card id mismatch: {seen} != {bob_id}");
    }
    let bob_id_bytes = hex::decode(&bob_id)?;

    // 2. Document + membership.
    let doc = step!("alice.create-doc(v1 head)", a.call_create_doc(acc, b"polymorph spike v1".to_vec()));
    let doc_id = doc.doc_id.clone();
    step!(
        "alice.add-member(bob, Read)",
        a.call_add_member(acc, doc_id.clone(), bob_id_bytes.clone())
    );
    let ev1 = step!(
        "alice.events-for-peer(bob)",
        a.call_events_for_peer(acc, bob_id_bytes.clone())
    );
    println!("            {} bytes of events", ev1.len());
    let stuck = step!("bob.ingest-events", b.call_ingest_events(acc, ev1.clone()));
    if stuck != 0 {
        bail!("bob has {stuck} stuck events after initial sync");
    }

    // 3. Encrypt v1 on Alice; decrypt on Bob.
    let v1: &[u8] = b"polymorph spike v1";
    let enc1 = step!(
        "alice.encrypt(v1)",
        a.call_encrypt(acc, doc_id.clone(), v1.to_vec(), vec![])
    );
    println!(
        "            ciphertext {} bytes, update-events: {}",
        enc1.ciphertext.len(),
        enc1.update_events.is_some()
    );
    if let Some(update) = &enc1.update_events {
        let stuck = step!("bob.ingest-events(v1 cgka update)", b.call_ingest_events(acc, update.clone()));
        if stuck != 0 {
            bail!("bob has {stuck} stuck events after v1 update");
        }
    }
    let p1 = step!("bob.decrypt(v1)", b.call_decrypt(acc, doc_id.clone(), enc1.ciphertext.clone()));
    if p1 != v1 {
        bail!("bob decrypted wrong plaintext for v1");
    }
    println!("            bob reads v1: OK");

    // 4. Revoke Bob; encrypt v2; adversarially deliver everything to Bob.
    step!(
        "alice.revoke-member(bob)",
        a.call_revoke_member(acc, doc_id.clone(), bob_id_bytes.clone())
    );
    let v2: &[u8] = b"polymorph spike v2 (bob must not read this)";
    let enc2 = step!(
        "alice.encrypt(v2, post-revocation)",
        a.call_encrypt(acc, doc_id.clone(), v2.to_vec(), enc1.content_ref.clone())
    );
    println!(
        "            ciphertext {} bytes, update-events: {}",
        enc2.ciphertext.len(),
        enc2.update_events.is_some()
    );
    // Deliver *everything* Alice has for Bob, plus the v2 rotation op:
    // exclusion must be cryptographic, not a delivery decision.
    let ev2 = step!(
        "alice.events-for-peer(bob, post-revocation)",
        a.call_events_for_peer(acc, bob_id_bytes.clone())
    );
    println!("            {} bytes of events", ev2.len());
    let _ = step!("bob.ingest-events(post-revocation)", b.call_ingest_events(acc, ev2));
    if let Some(update) = &enc2.update_events {
        let _ = step!(
            "bob.ingest-events(v2 cgka update, adversarial)",
            b.call_ingest_events(acc, update.clone())
        );
    }
    let t = Instant::now();
    match b.call_decrypt(acc, doc_id.clone(), enc2.ciphertext.clone()).await? {
        Ok(_) => bail!("SECURITY FAILURE: revoked bob decrypted v2"),
        Err(e) => println!(
            "[{:>9.2?}] bob.decrypt(v2) refused as required: {e}",
            t.elapsed()
        ),
    }

    // 5. History stays readable (causal keys): bob re-reads v1.
    let t = Instant::now();
    match b.call_decrypt(acc, doc_id.clone(), enc1.ciphertext.clone()).await? {
        Ok(p) if p == v1 => println!(
            "[{:>9.2?}] bob.decrypt(v1) after revocation: still readable (causal keys)",
            t.elapsed()
        ),
        Ok(_) => bail!("bob re-decrypted v1 to wrong plaintext"),
        Err(e) => println!(
            "[{:>9.2?}] bob.decrypt(v1) after revocation: REFUSED ({e}) — record as finding",
            t.elapsed()
        ),
    }

    // 6. Archive round-trip on Alice, then keep working.
    let summary = step!("alice.archive-roundtrip", a.call_archive_roundtrip(acc));
    println!("            {summary}");
    let v3: &[u8] = b"polymorph spike v3 (post-restore)";
    let enc3 = step!(
        "alice.encrypt(v3, post-restore)",
        a.call_encrypt(acc, doc_id.clone(), v3.to_vec(), enc2.content_ref.clone())
    );
    let t = Instant::now();
    match b.call_decrypt(acc, doc_id.clone(), enc3.ciphertext.clone()).await? {
        Ok(_) => bail!("SECURITY FAILURE: revoked bob decrypted v3"),
        Err(_) => println!(
            "[{:>9.2?}] bob.decrypt(v3) refused as required (revocation survives archive)",
            t.elapsed()
        ),
    }

    let a_stats = a.call_stats(acc).await?;
    let b_stats = b.call_stats(acc).await?;
    println!("\nalice: {a_stats}");
    println!("bob:   {b_stats}");
    println!("\nSPIKE PASSED");
    Ok(())
}
