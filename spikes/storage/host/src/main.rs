//! Storage-spike host: five instances of the composed component (Alice's
//! laptop and phone, Bob, and two resurrections of Bob's cracked image)
//! against a real S3 server (MinIO), serving wasi p2+p3, wasi:http p3, and
//! polymorph:webcrypto.
//!
//! Asserts, in order: device convergence through the bucket; account-less
//! recipient reads via K_p → name-keys → manifests → chunks (unsigned
//! GETs); a pre-revocation cracked image CAN read (image sufficiency);
//! revocation deletes K_p and rotates the epoch; the stock client and the
//! same cracked image both go dark afterwards; the owner's other device
//! keeps working across the rotation; unsigned writes and listing are
//! refused (public read is per-object, not enumeration).

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
        imports: {
            default: async | store | trappable,
        },
        exports: {
            default: async,
        },
    });
}

use bindings::exports::polymorph::storage_spike::driver::Guest as Driver;

struct Ctx {
    wasi: WasiCtx,
    webcrypto: WasiWebcryptoCtx,
    http: wasmtime_wasi_http::WasiHttpCtx,
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

impl wasmtime_wasi_http::p3::WasiHttpView for Ctx {
    fn http(&mut self) -> wasmtime_wasi_http::p3::WasiHttpCtxView<'_> {
        wasmtime_wasi_http::p3::WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: wasmtime_wasi_http::p3::default_hooks(),
        }
    }
}

struct Cli {
    component: PathBuf,
    endpoint: String,
    bucket: String,
    access: String,
    secret: String,
}

fn parse_args() -> Result<Cli> {
    let mut args = std::env::args().skip(1);
    let component = PathBuf::from(args.next().ok_or_else(|| format_err!("component path"))?);
    let mut endpoint = "http://127.0.0.1:9000".to_string();
    let mut bucket = "pm-storage-spike".to_string();
    let mut access = "minioadmin".to_string();
    let mut secret = "minioadmin".to_string();
    while let Some(arg) = args.next() {
        let mut next = |what: &str| args.next().ok_or_else(|| format_err!("{what} needs a value"));
        match arg.as_str() {
            "--endpoint" => endpoint = next("--endpoint")?,
            "--bucket" => bucket = next("--bucket")?,
            "--access" => access = next("--access")?,
            "--secret" => secret = next("--secret")?,
            other => bail!("unknown argument {other}"),
        }
    }
    Ok(Cli {
        component,
        endpoint,
        bucket,
        access,
        secret,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = parse_args()?;

    let mut config = Config::new();
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    let engine = Engine::new(&config)?;

    let component = Component::from_file(&engine, &cli.component)
        .with_context(|| format!("loading component {}", cli.component.display()))?;

    let mut linker: Linker<Ctx> = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    wasmtime_wasi_http::p3::add_to_linker(&mut linker)?;
    polymorph_webcrypto_wasmtime::add_to_linker(&mut linker)?;

    let mut store = Store::new(
        &engine,
        Ctx {
            wasi: WasiCtxBuilder::new().inherit_stdout().inherit_stderr().build(),
            webcrypto: WasiWebcryptoCtx::new(),
            http: wasmtime_wasi_http::WasiHttpCtx::new(),
            table: ResourceTable::new(),
        },
    );

    let t0 = Instant::now();
    let laptop = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let phone = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let bob = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let res1 = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let res2 = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    println!("[{:>9.2?}] instantiated 5 clients", t0.elapsed());

    store
        .run_concurrent(async move |acc| {
            scenario(acc, cli, laptop, phone, bob, res1, res2).await
        })
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

#[allow(clippy::too_many_arguments)]
async fn scenario(
    acc: &Accessor<Ctx>,
    cli: Cli,
    laptop: bindings::Spike,
    phone: bindings::Spike,
    bob: bindings::Spike,
    res1: bindings::Spike,
    res2: bindings::Spike,
) -> Result<()> {
    let a: &Driver = laptop.polymorph_storage_spike_driver();
    let b: &Driver = phone.polymorph_storage_spike_driver();
    let r: &Driver = bob.polymorph_storage_spike_driver();
    let r1: &Driver = res1.polymorph_storage_spike_driver();
    let r2: &Driver = res2.polymorph_storage_spike_driver();

    // 1. Identities + store config. Bob gets no credentials.
    let a_dev = step!(
        "laptop.init (owner creds)",
        a.call_init(
            acc,
            cli.endpoint.clone(),
            cli.bucket.clone(),
            cli.access.clone(),
            cli.secret.clone()
        )
    );
    let _b_dev = step!(
        "phone.init  (owner creds)",
        b.call_init(
            acc,
            cli.endpoint.clone(),
            cli.bucket.clone(),
            cli.access.clone(),
            cli.secret.clone()
        )
    );
    let _bob_dev = step!(
        "bob.init    (NO credentials)",
        r.call_init(
            acc,
            cli.endpoint.clone(),
            cli.bucket.clone(),
            String::new(),
            String::new()
        )
    );
    let a_dev_bytes = hex::decode(&a_dev).map_err(|e| format_err!("{e}"))?;
    let owner_pub = step!("laptop.x25519-pub", a.call_x25519_pub(acc));
    let bob_pub = step!("bob.x25519-pub", r.call_x25519_pub(acc));

    step!("laptop.ensure-bucket-public", a.call_ensure_bucket_public(acc));

    // 2. Doc, grant, first content.
    let doc = step!("laptop.create-doc", a.call_create_doc(acc));
    step!(
        "laptop.grant(bob)",
        a.call_grant(acc, doc.clone(), bob_pub.clone())
    );
    let _cref1 = step!(
        "laptop.author(v1)",
        a.call_author(acc, doc.clone(), "backup v1".into())
    );

    // 3. Device convergence through the bucket.
    let epoch = step!("laptop.export-epoch", a.call_export_epoch(acc, doc.clone()));
    step!(
        "phone.adopt-doc",
        b.call_adopt_doc(acc, doc.clone(), epoch, vec![a_dev_bytes.clone()])
    );
    let view = step!("phone.read-own(v1)", b.call_read_own(acc, doc.clone()));
    if view.text != "backup v1" || view.chunks_read != 1 {
        bail!("phone's v1 view is wrong: {view:?}");
    }
    println!("            phone converged through the bucket: {:?}", view.text);

    // 4. Account-less recipient.
    let view = step!(
        "bob.read-shared(v1, unsigned GETs only)",
        r.call_read_shared(acc, doc.clone(), owner_pub.clone(), vec![a_dev_bytes.clone()])
    );
    if view.text != "backup v1" || view.chunks_read != 1 {
        bail!("bob's v1 view is wrong: {view:?}");
    }
    println!("            bob (no account) reads: {:?}", view.text);

    // 5. Second version; fresh recipient session re-derives everything.
    let _cref2 = step!(
        "laptop.author(v2)",
        a.call_author(acc, doc.clone(), "backup v2".into())
    );
    let view = step!(
        "bob.read-shared(v2)",
        r.call_read_shared(acc, doc.clone(), owner_pub.clone(), vec![a_dev_bytes.clone()])
    );
    if view.text != "backup v2" || view.chunks_read != 2 {
        bail!("bob's v2 view is wrong: {view:?}");
    }

    // 6. The cracked image, taken BEFORE revocation, works while K_p lives:
    // image sufficiency, which is what makes the later darkness meaningful.
    let image = step!("bob.cracked-image", r.call_cracked_image(acc));
    step!(
        "res1.init (thief's own client)",
        r1.call_init(acc, cli.endpoint.clone(), cli.bucket.clone(), String::new(), String::new())
    );
    step!("res1.import-image", r1.call_import_image(acc, image.clone()));
    let view = step!(
        "res1.read-shared (pre-revocation crack: succeeds)",
        r1.call_read_shared(acc, doc.clone(), owner_pub.clone(), vec![a_dev_bytes.clone()])
    );
    if view.text != "backup v2" {
        bail!("res1 should read v2: {view:?}");
    }

    // 7. Revocation: delete K_p, rotate the epoch; author v3.
    step!(
        "laptop.revoke(bob)",
        a.call_revoke(acc, doc.clone(), bob_pub.clone())
    );
    let _cref3 = step!(
        "laptop.author(v3, post-revocation)",
        a.call_author(acc, doc.clone(), "backup v3 (bob must not see)".into())
    );

    // 8. The stock client goes dark on its next session.
    let t = Instant::now();
    match r
        .call_read_shared(acc, doc.clone(), owner_pub.clone(), vec![a_dev_bytes.clone()])
        .await?
    {
        Ok(view) => bail!("PULL FAILURE: revoked bob still reads {view:?}"),
        Err(e) => {
            if !e.contains("kp missing") {
                bail!("expected kp-missing darkness, got: {e}");
            }
            println!("[{:>9.2?}] bob.read-shared refused: {e}", t.elapsed());
        }
    }

    // 9. The stolen-device assertion: the SAME image that worked in (6)
    // retrieves nothing after revocation.
    step!(
        "res2.init (thief's own client)",
        r2.call_init(acc, cli.endpoint.clone(), cli.bucket.clone(), String::new(), String::new())
    );
    step!("res2.import-image (same image)", r2.call_import_image(acc, image));
    let t = Instant::now();
    match r2
        .call_read_shared(acc, doc.clone(), owner_pub.clone(), vec![a_dev_bytes.clone()])
        .await?
    {
        Ok(view) => bail!("STOLEN-DEVICE FAILURE: cracked image still reads {view:?}"),
        Err(e) => {
            if !e.contains("kp missing") {
                bail!("expected kp-missing darkness, got: {e}");
            }
            println!(
                "[{:>9.2?}] res2.read-shared refused: {e} — cracked image yields nothing new",
                t.elapsed()
            );
        }
    }

    // 10. The owner's other device rides the rotation.
    let epoch = step!("laptop.export-epoch (rotated)", a.call_export_epoch(acc, doc.clone()));
    step!(
        "phone.adopt-doc (rotated)",
        b.call_adopt_doc(acc, doc.clone(), epoch, vec![a_dev_bytes.clone()])
    );
    let view = step!("phone.read-own(v3)", b.call_read_own(acc, doc.clone()));
    if view.text != "backup v3 (bob must not see)" || view.chunks_read != 3 {
        bail!("phone's v3 view is wrong: {view:?}");
    }
    println!("            phone reads across the rotation: {:?}", view.text);

    // 11. The bucket refuses unsigned writes and enumeration.
    let status = step!("probe: unsigned PUT", r.call_probe_put(acc, "junk-object".into()));
    if status != 403 {
        bail!("unsigned PUT was not refused: {status}");
    }
    let status = step!("probe: unsigned LIST", r.call_probe_list(acc));
    if status != 403 {
        bail!("unsigned LIST was not refused: {status}");
    }
    println!("            unsigned PUT/LIST refused (public read is per-object)");

    for (name, d) in [("laptop", a), ("phone", b), ("bob", r)] {
        let s = d.call_stats(acc).await?;
        println!("{name}: {s}");
    }
    println!("\nSPIKE PASSED");
    Ok(())
}
