//! Dropbox-spike host: six instances of the composed component — Alice's
//! laptop and phone (owner devices, full credentials), Bob and Carol
//! (account-less recipients, no token at all), and two resurrections of
//! Bob's cracked image — driven against LIVE consumer Dropbox, serving
//! wasi p2+p3, wasi:http p3, and polymorph:webcrypto.
//!
//! Asserts, in order: device convergence through the store on the owner
//! (Bearer) tier; account-less recipient reads over shared links; a
//! pre-revocation cracked image CAN read (image sufficiency, which is what
//! makes the later darkness meaningful); after revocation the stock client
//! goes dark AND the hoarded container link is refused server-side — the
//! assertion the name-secrecy strategy cannot make; a remaining recipient
//! rides the rotation through her unchanged standing link; the owner's
//! other device rides it too; and writes stay owner-token-only while even
//! public links require the app-auth mediator.

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

use bindings::exports::polymorph::dropbox_spike::driver::Guest as Driver;

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
    app_key: String,
    app_secret: String,
    access_token: String,
}

fn parse_args() -> Result<Cli> {
    let mut args = std::env::args().skip(1);
    let component = PathBuf::from(args.next().ok_or_else(|| format_err!("component path"))?);
    let mut creds: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        let mut next = |what: &str| args.next().ok_or_else(|| format_err!("{what} needs a value"));
        match arg.as_str() {
            "--creds" => creds = Some(PathBuf::from(next("--creds")?)),
            other => bail!("unknown argument {other}"),
        }
    }
    let creds = creds.ok_or_else(|| format_err!("--creds <path> is required"))?;
    let raw = std::fs::read_to_string(&creds)
        .with_context(|| format!("reading creds {}", creds.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| format!("parsing {}", creds.display()))?;
    let field = |name: &str| -> Result<String> {
        json.get(name)
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .ok_or_else(|| format_err!("{}: missing string field {name}", creds.display()))
    };
    Ok(Cli {
        component,
        app_key: field("appKey")?,
        app_secret: field("appSecret")?,
        access_token: field("accessToken")?,
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
    let carol = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let res1 = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let res2 = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    println!("[{:>9.2?}] instantiated 6 clients", t0.elapsed());

    store
        .run_concurrent(async move |acc| {
            scenario(acc, cli, laptop, phone, bob, carol, res1, res2).await
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
    carol: bindings::Spike,
    res1: bindings::Spike,
    res2: bindings::Spike,
) -> Result<()> {
    let a: &Driver = laptop.polymorph_dropbox_spike_driver();
    let b: &Driver = phone.polymorph_dropbox_spike_driver();
    let r: &Driver = bob.polymorph_dropbox_spike_driver();
    let c: &Driver = carol.polymorph_dropbox_spike_driver();
    let r1: &Driver = res1.polymorph_dropbox_spike_driver();
    let r2: &Driver = res2.polymorph_dropbox_spike_driver();

    // A per-run namespace inside the app folder; `cleanup` deletes it.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before epoch")
        .subsec_nanos()
        ^ std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before epoch")
            .as_secs() as u32;
    let root = format!("run-{nanos:08x}");
    println!("            run root: /{root}");

    // 1. Identities + credentials. Recipients get NO access token.
    let a_dev = step!(
        "laptop.init (owner token)",
        a.call_init(
            acc,
            root.clone(),
            cli.app_key.clone(),
            cli.app_secret.clone(),
            cli.access_token.clone()
        )
    );
    let _b_dev = step!(
        "phone.init  (owner token)",
        b.call_init(
            acc,
            root.clone(),
            cli.app_key.clone(),
            cli.app_secret.clone(),
            cli.access_token.clone()
        )
    );
    let _bob_dev = step!(
        "bob.init    (app auth only)",
        r.call_init(
            acc,
            root.clone(),
            cli.app_key.clone(),
            cli.app_secret.clone(),
            String::new()
        )
    );
    let _carol_dev = step!(
        "carol.init  (app auth only)",
        c.call_init(
            acc,
            root.clone(),
            cli.app_key.clone(),
            cli.app_secret.clone(),
            String::new()
        )
    );
    let a_dev_bytes = hex::decode(&a_dev).map_err(|e| format_err!("{e}"))?;
    let owner_pub = step!("laptop.x25519-pub", a.call_x25519_pub(acc));
    let bob_pub = step!("bob.x25519-pub", r.call_x25519_pub(acc));
    let carol_pub = step!("carol.x25519-pub", c.call_x25519_pub(acc));

    let doc = step!("laptop.create-doc", a.call_create_doc(acc));

    // 2. Grants: each recipient gets their own standing pickup link.
    let bob_pickup = step!(
        "laptop.grant(bob)",
        a.call_grant(acc, doc.clone(), bob_pub.clone())
    );
    let carol_pickup = step!(
        "laptop.grant(carol)",
        a.call_grant(acc, doc.clone(), carol_pub.clone())
    );

    // 3. First content.
    let _cref1 = step!(
        "laptop.author(v1)",
        a.call_author(acc, doc.clone(), "backup v1".into())
    );

    // 4. Device convergence through the store: Bearer paths only, no
    // links involved.
    let export = step!("laptop.export-doc", a.call_export_doc(acc, doc.clone()));
    step!(
        "phone.adopt-doc",
        b.call_adopt_doc(acc, doc.clone(), export, vec![a_dev_bytes.clone()])
    );
    let view = step!("phone.read-own(v1)", b.call_read_own(acc, doc.clone()));
    if view.text != "backup v1" || view.chunks_read != 1 {
        bail!("phone's v1 view is wrong: {view:?}");
    }
    println!("            phone converged through the store: {:?}", view.text);

    // 5. Account-less recipient over links.
    let view = step!(
        "bob.read-shared(v1, link fetches only)",
        r.call_read_shared(
            acc,
            doc.clone(),
            bob_pickup.clone(),
            owner_pub.clone(),
            vec![a_dev_bytes.clone()]
        )
    );
    if view.text != "backup v1" || view.chunks_read != 1 {
        bail!("bob's v1 view is wrong: {view:?}");
    }
    println!("            bob (no account) reads: {:?}", view.text);

    // 6. Second version; both recipients see it through their standing
    // links, unchanged.
    let _cref2 = step!(
        "laptop.author(v2)",
        a.call_author(acc, doc.clone(), "backup v2".into())
    );
    let view = step!(
        "bob.read-shared(v2)",
        r.call_read_shared(
            acc,
            doc.clone(),
            bob_pickup.clone(),
            owner_pub.clone(),
            vec![a_dev_bytes.clone()]
        )
    );
    if view.text != "backup v2" || view.chunks_read != 2 {
        bail!("bob's v2 view is wrong: {view:?}");
    }
    let view = step!(
        "carol.read-shared(v2)",
        c.call_read_shared(
            acc,
            doc.clone(),
            carol_pickup.clone(),
            owner_pub.clone(),
            vec![a_dev_bytes.clone()]
        )
    );
    if view.text != "backup v2" || view.chunks_read != 2 {
        bail!("carol's v2 view is wrong: {view:?}");
    }

    // 7. The cracked image, taken BEFORE revocation, works: image
    // sufficiency. Without this the later darkness would prove nothing.
    let image = step!("bob.cracked-image", r.call_cracked_image(acc));
    println!("            cracked image: {} bytes", image.len());
    step!(
        "res1.init (thief's own client)",
        r1.call_init(
            acc,
            root.clone(),
            cli.app_key.clone(),
            cli.app_secret.clone(),
            String::new()
        )
    );
    step!("res1.import-image", r1.call_import_image(acc, image.clone()));
    let view = step!(
        "res1.read-cracked (pre-revocation crack: succeeds)",
        r1.call_read_cracked(acc)
    );
    if view.text != "backup v2" {
        bail!("res1 should read v2: {view:?}");
    }
    println!("            the image IS sufficient pre-revocation — that is what makes the darkness below meaningful");

    // 8. Revocation, then new content bob must not reach.
    step!(
        "laptop.revoke(bob)",
        a.call_revoke(acc, doc.clone(), bob_pub.clone())
    );
    let _cref3 = step!(
        "laptop.author(v3, post-revocation)",
        a.call_author(acc, doc.clone(), "backup v3 (bob must not see)".into())
    );

    // 9. The stock client goes dark on its next session: its standing
    // capability is refused server-side.
    let t = Instant::now();
    match r
        .call_read_shared(
            acc,
            doc.clone(),
            bob_pickup.clone(),
            owner_pub.clone(),
            vec![a_dev_bytes.clone()],
        )
        .await?
    {
        Ok(view) => bail!("PULL FAILURE: revoked bob still reads {view:?}"),
        Err(e) => {
            if !e.contains("pickup link refused") {
                bail!("PULL FAILURE: expected a refused pickup link, got: {e}");
            }
            println!("[{:>9.2?}] bob.read-shared refused: {e}", t.elapsed());
        }
    }

    // 10. The stolen-device assertion: the SAME image that worked in (7)
    // retrieves nothing — including through the link it hoarded.
    step!(
        "res2.init (thief's own client)",
        r2.call_init(
            acc,
            root.clone(),
            cli.app_key.clone(),
            cli.app_secret.clone(),
            String::new()
        )
    );
    step!("res2.import-image (same image)", r2.call_import_image(acc, image));
    let t = Instant::now();
    match r2.call_read_cracked(acc).await? {
        Ok(view) => bail!("STOLEN-DEVICE FAILURE: cracked image still reads {view:?}"),
        Err(e) => {
            if !e.contains("pickup link refused") || !e.contains("hoarded doc link refused") {
                bail!("STOLEN-DEVICE FAILURE: expected both links refused, got: {e}");
            }
            println!("[{:>9.2?}] res2.read-cracked refused: {e}", t.elapsed());
            println!("            even the HOARDED container link is dead server-side — the assertion the name-secrecy strategy cannot make");
        }
    }

    // 11. The remaining recipient rides the rotation through the SAME
    // standing link: her pickup object was overwritten in place.
    let view = step!(
        "carol.read-shared(v3, same standing link)",
        c.call_read_shared(
            acc,
            doc.clone(),
            carol_pickup.clone(),
            owner_pub.clone(),
            vec![a_dev_bytes.clone()]
        )
    );
    if view.text != "backup v3 (bob must not see)" || view.chunks_read != 3 {
        bail!("carol's v3 view is wrong: {view:?}");
    }
    println!("            carol rode the rotation without a new capability");

    // 12. The owner's other device rides it too (Bearer tier, untouched).
    let export = step!(
        "laptop.export-doc (rotated)",
        a.call_export_doc(acc, doc.clone())
    );
    step!(
        "phone.adopt-doc (rotated)",
        b.call_adopt_doc(acc, doc.clone(), export, vec![a_dev_bytes.clone()])
    );
    let view = step!("phone.read-own(v3)", b.call_read_own(acc, doc.clone()));
    if view.text != "backup v3 (bob must not see)" || view.chunks_read != 3 {
        bail!("phone's v3 view is wrong: {view:?}");
    }
    println!("            phone reads across the rotation: {:?}", view.text);

    // 13. The refusal probes.
    let status = step!(
        "probe: no-auth link fetch",
        r.call_probe_noauth(acc, carol_pickup.clone())
    );
    if status != 401 {
        bail!("no-auth link fetch was not refused: {status}");
    }
    let status = step!(
        "probe: app-auth write",
        r.call_probe_write(acc, "junk-object".into())
    );
    // Dropbox answers this with 401 or 400 depending on which layer
    // rejects the credential first (observed both, live); the invariant is
    // refusal, not the status code.
    if !(400..500).contains(&status) {
        bail!("app-auth write was not refused: {status}");
    }
    println!("            writes are owner-token-only; even public links need the app-auth mediator");

    // 14. Stats and teardown.
    for (name, d) in [("laptop", a), ("phone", b), ("bob", r), ("carol", c)] {
        let s = d.call_stats(acc).await?;
        println!("{name}: {s}");
    }
    step!("laptop.cleanup", a.call_cleanup(acc));
    println!("\nSPIKE PASSED");
    Ok(())
}
