//! Engine-spike host: three engine instances — Alice's laptop and phone
//! (device stand-in: both direct members) and Bob (collaborator) — over
//! iroh, exercising the tasks data service on the automerge change DAG.
//!
//! Asserts: creation → members (edit) → seal ordering; convergence of the
//! task list across all three; a genuine concurrency fork (laptop and
//! phone author from the same frontier) merged by a later change (a chunk
//! with two parents exists); collaborator edits propagate; revocation cuts
//! Bob off from new epochs while laptop and phone ride the rotation.

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

use bindings::exports::polymorph::engine_spike::driver::{Guest as Driver, S3Config, StoreConfig};
use bindings::exports::polymorph_data::tasks::tasks::{Guest as Tasks, TodoItem};

struct Ctx {
    wasi: WasiCtx,
    webcrypto: WasiWebcryptoCtx,
    websocket: WasiWebsocketCtx,
    webrtc: WebrtcCtx,
    http: wasmtime_wasi_http::WasiHttpCtx,
    table: ResourceTable,
}

impl HasData for Ctx {
    type Data<'a> = &'a mut Self;
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
    let mut endpoint = "http://127.0.0.1:9000".to_string();
    let mut bucket = "pm-tasks-spike".to_string();
    let mut access = "minioadmin".to_string();
    let mut secret = "minioadmin".to_string();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--relay" => relay = args.next().ok_or_else(|| format_err!("--relay needs a URL"))?,
            "--endpoint" => {
                endpoint = args.next().ok_or_else(|| format_err!("--endpoint needs a URL"))?
            }
            "--bucket" => bucket = args.next().ok_or_else(|| format_err!("--bucket needs a name"))?,
            "--access" => access = args.next().ok_or_else(|| format_err!("--access needs a key"))?,
            "--secret" => secret = args.next().ok_or_else(|| format_err!("--secret needs a key"))?,
            other => bail!("unknown argument {other}"),
        }
    }
    let s3 = S3Args {
        endpoint,
        bucket,
        access,
        secret,
    };

    let mut config = Config::new();
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    let engine = Engine::new(&config)?;

    let component = Component::from_file(&engine, &path)
        .with_context(|| format!("loading component {}", path.display()))?;

    let mut linker: Linker<Ctx> = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    wasmtime_wasi_http::p3::add_to_linker(&mut linker)?;
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
            http: wasmtime_wasi_http::WasiHttpCtx::new(),
            table: ResourceTable::new(),
        },
    );

    let t0 = Instant::now();
    let laptop = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let phone = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let bob = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let tablet = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let laptop2 = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    let laptop3 = bindings::Spike::instantiate_async(&mut store, &component, &linker).await?;
    println!(
        "[{:>9.2?}] instantiated laptop + phone + bob + tablet (+2 restart shells)",
        t0.elapsed()
    );

    store
        .run_concurrent(async move |acc| {
            scenario(acc, laptop, phone, bob, tablet, laptop2, laptop3, relay, s3).await
        })
        .await?
}

struct S3Args {
    endpoint: String,
    bucket: String,
    access: String,
    secret: String,
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

/// Establish an iroh wire between two instances (initiator ← acceptor) and
/// wait for the subduction handshake on both ends.
async fn connect(
    acc: &Accessor<Ctx>,
    initiator: (&Driver, &str, &[u8]),
    acceptor: (&Driver, &str, &str),
    relay: &str,
) -> Result<()> {
    let (ini, ini_name, acceptor_sd_id) = initiator;
    let (acp, acp_name, acp_endpoint) = acceptor;
    let ep_bytes = hex::decode(acp_endpoint).map_err(|e| format_err!("{e}"))?;
    let ca = acp
        .call_iroh_start(acc, false, vec![], relay.to_string(), vec![])
        .await?
        .map_err(|e| format_err!("{acp_name} accept: {e}"))?;
    let cb = ini
        .call_iroh_start(acc, true, ep_bytes, relay.to_string(), acceptor_sd_id.to_vec())
        .await?
        .map_err(|e| format_err!("{ini_name} connect: {e}"))?;
    let t = Instant::now();
    let (mut a, mut b) = (None, None);
    for _ in 0..2000 {
        if a.is_none() {
            a = ini
                .call_conn_status(acc, cb)
                .await?
                .map_err(|e| format_err!("{ini_name} handshake: {e}"))?;
        }
        if b.is_none() {
            b = acp
                .call_conn_status(acc, ca)
                .await?
                .map_err(|e| format_err!("{acp_name} handshake: {e}"))?;
        }
        if a.is_some() && b.is_some() {
            println!(
                "[{:>9.2?}] wire up: {ini_name} <-> {acp_name}",
                t.elapsed()
            );
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    bail!("wire {ini_name}<->{acp_name} did not come up")
}

/// Poll a tasks view until `want` returns true for the snapshot. Errors are
/// treated as not-ready (e.g. epoch material still in flight on the bridge)
/// but remembered for the timeout report.
async fn wait_items(
    acc: &Accessor<Ctx>,
    t: &Tasks,
    what: &str,
    want: impl Fn(&[TodoItem]) -> bool,
) -> Result<Vec<TodoItem>> {
    let start = Instant::now();
    let mut last_err = None;
    for _ in 0..2000 {
        match t.call_items(acc).await? {
            Ok(snap) => {
                if want(&snap.items) {
                    println!("[{:>9.2?}] {what}", start.elapsed());
                    return Ok(snap.items);
                }
            }
            Err(e) => last_err = Some(e),
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    bail!("{what}: condition never held (last error: {last_err:?})")
}

/// Generated WIT records don't derive PartialEq; compare by content.
fn same(a: &[TodoItem], b: &[TodoItem]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x.id == y.id && x.title == y.title && x.completed == y.completed)
}

fn render(items: &[TodoItem]) -> String {
    items
        .iter()
        .map(|i| {
            format!(
                "[{}] {}",
                if i.completed { "x" } else { " " },
                i.title
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[allow(clippy::too_many_arguments)]
async fn scenario(
    acc: &Accessor<Ctx>,
    laptop: bindings::Spike,
    phone: bindings::Spike,
    bob: bindings::Spike,
    tablet: bindings::Spike,
    laptop2: bindings::Spike,
    laptop3: bindings::Spike,
    relay: String,
    s3: S3Args,
) -> Result<()> {
    let l: &Driver = laptop.polymorph_engine_spike_driver();
    let p: &Driver = phone.polymorph_engine_spike_driver();
    let b: &Driver = bob.polymorph_engine_spike_driver();
    let tb: &Driver = tablet.polymorph_engine_spike_driver();
    let l2: &Driver = laptop2.polymorph_engine_spike_driver();
    let l3: &Driver = laptop3.polymorph_engine_spike_driver();
    let lt: &Tasks = laptop.polymorph_data_tasks_tasks();
    let pt: &Tasks = phone.polymorph_data_tasks_tasks();
    let bt: &Tasks = bob.polymorph_data_tasks_tasks();
    let tt: &Tasks = tablet.polymorph_data_tasks_tasks();
    let l2t: &Tasks = laptop2.polymorph_data_tasks_tasks();

    // 1. Identities; hub topology (laptop is the wire hub). The TABLET
    // never binds, never connects: it will live entirely off the bucket.
    // Laptop uses the G5 demo-grade SOFT identity (bundle-exportable);
    // everyone else keeps the platform-held default.
    let l_id = step!("laptop.init (soft identity)", l.call_init(acc, true));
    let p_id = step!("phone.init ", p.call_init(acc, false));
    let b_id = step!("bob.init   ", b.call_init(acc, false));
    let t_id = step!("tablet.init", tb.call_init(acc, false));
    let l_id_bytes = hex::decode(&l_id).map_err(|e| format_err!("{e}"))?;
    let p_id_bytes = hex::decode(&p_id).map_err(|e| format_err!("{e}"))?;
    let b_id_bytes = hex::decode(&b_id).map_err(|e| format_err!("{e}"))?;
    let t_id_bytes = hex::decode(&t_id).map_err(|e| format_err!("{e}"))?;

    let _l_ep = step!("laptop.iroh-bind", l.call_iroh_bind(acc, relay.clone()));
    let p_ep = step!("phone.iroh-bind ", p.call_iroh_bind(acc, relay.clone()));
    let b_ep = step!("bob.iroh-bind   ", b.call_iroh_bind(acc, relay.clone()));

    connect(acc, (l, "laptop", &p_id_bytes), (p, "phone", p_ep.as_str()), &relay).await?;
    connect(acc, (l, "laptop", &b_id_bytes), (b, "bob", b_ep.as_str()), &relay).await?;

    // Contact cards travel over the bridge.
    let t = Instant::now();
    let mut known = false;
    for _ in 0..2000 {
        let kp = l
            .call_kh_knows_agent(acc, p_id_bytes.clone())
            .await?
            .map_err(|e| format_err!("{e}"))?;
        let kb = l
            .call_kh_knows_agent(acc, b_id_bytes.clone())
            .await?
            .map_err(|e| format_err!("{e}"))?;
        if kp && kb {
            known = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    if !known {
        bail!("contact cards did not propagate");
    }
    println!("[{:>9.2?}] contact cards exchanged over the bridge", t.elapsed());

    // 2. Users are groups of devices (G3, #10's minimal slice).
    // Alice: laptop creates her user group and enrolls the phone (its
    // contact card arrived over the bridge) and the tablet (its card is
    // pasted — it has no wire). Bob: his own user group.
    let alice_g = step!("laptop.kh-create-group (user 'alice')", l.call_kh_create_group(acc));
    step!(
        "laptop.kh-add-to-group(phone, edit) [enrollment]",
        l.call_kh_add_to_group(acc, alice_g.clone(), p_id_bytes.clone(), "edit".into())
    );
    let tablet_card = step!("tablet.kh-contact-card [QR paste]", tb.call_kh_contact_card(acc));
    step!(
        "laptop.kh-ingest-contact(tablet)",
        l.call_kh_ingest_contact(acc, tablet_card)
    );
    step!(
        "laptop.kh-add-to-group(tablet, edit) [enrollment, wireless]",
        l.call_kh_add_to_group(acc, alice_g.clone(), t_id_bytes.clone(), "edit".into())
    );
    // The tablet needs the owner's contact card for the K_p prekey DH.
    let laptop_card = step!("laptop.kh-contact-card", l.call_kh_contact_card(acc));
    step!(
        "tablet.kh-ingest-contact(laptop)",
        tb.call_kh_ingest_contact(acc, laptop_card)
    );
    let bob_g = step!("bob.kh-create-group (user 'bob')", b.call_kh_create_group(acc));

    // The bridge only offers a group's ops to its members, so Alice can't
    // resolve Bob's group from the wire alone. Bob exports HIS OWN card
    // (an agent's card carries the memberships it can reach — for bob:
    // his user group's constitutive ops plus his prekeys) and Alice
    // ingests it. QR/paste in the product; the host carries it here.
    let bob_card = step!(
        "bob.kh-export-card(bob) [self card: individual + group]",
        b.call_kh_export_card(acc, b_id_bytes.clone())
    );
    println!("            card: {} bytes", bob_card.len());
    let pending = step!(
        "laptop.kh-ingest-card(bob-group)",
        l.call_kh_ingest_card(acc, bob_card.clone())
    );
    println!("            events pending after ingest: {pending}");
    // The card must ALSO reach Alice's other devices: the bridge's
    // reachability model never offers a foreign group's constitutive ops
    // to non-members, so a paste on one device cannot propagate to the
    // rest over the wire. (Design note for the product: carry received
    // cards inside a doc the user's devices share.)
    let pending_p = step!(
        "phone.kh-ingest-card(bob-group)",
        p.call_kh_ingest_card(acc, bob_card.clone())
    );
    println!("            events pending after ingest (phone): {pending_p}");
    let pending_t = step!(
        "tablet.kh-ingest-card(bob-group)",
        tb.call_kh_ingest_card(acc, bob_card)
    );
    println!("            events pending after ingest (tablet): {pending_t}");
    // Contact exchange is mutual: bob gets Alice's card (her individual
    // reaches alice-group, so the card carries the group's ops).
    let alice_card = step!(
        "laptop.kh-export-card(alice) [self card]",
        l.call_kh_export_card(acc, l_id_bytes.clone())
    );
    let pending_b = step!(
        "bob.kh-ingest-card(alice-group)",
        b.call_kh_ingest_card(acc, alice_card)
    );
    println!("            events pending after ingest (bob): {pending_b}");
    let t = Instant::now();
    let mut known = false;
    for _ in 0..2000 {
        if l
            .call_kh_knows_agent(acc, bob_g.clone())
            .await?
            .map_err(|e| format_err!("{e}"))?
        {
            known = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    if !known {
        bail!("laptop never resolved bob's group from the ingested card");
    }
    println!("[{:>9.2?}] laptop resolves bob's group as an agent", t.elapsed());

    // 3. Partition lifecycle: create → delegate to GROUPS → seal. Phone
    // and bob get access transitively (individual → user group → doc);
    // the epoch at seal time covers all transitive individuals.
    let part = step!("laptop.create-partition", l.call_create_partition(acc));
    step!(
        "laptop.kh-add-member(alice-group, edit)",
        l.call_kh_add_member(acc, part.clone(), alice_g.clone(), "edit".into())
    );
    step!(
        "laptop.kh-add-member(bob-group, edit)",
        l.call_kh_add_member(acc, part.clone(), bob_g.clone(), "edit".into())
    );
    step!("laptop.seal-partition", l.call_seal_partition(acc, part.clone()));
    step!("phone.adopt-partition", p.call_adopt_partition(acc, part.clone()));
    step!("bob.adopt-partition  ", b.call_adopt_partition(acc, part.clone()));
    step!("tablet.adopt-partition", tb.call_adopt_partition(acc, part.clone()));

    // Members subscribe to the hub.
    for (d, name) in [(p, "phone"), (b, "bob")] {
        let h = d
            .call_sync_start(acc, l_id_bytes.clone(), part.clone(), true)
            .await?
            .map_err(|e| format_err!("{name} sync-start: {e}"))?;
        let t = Instant::now();
        loop {
            match d.call_sync_status(acc, h).await? {
                Ok(Some(summary)) => {
                    println!("[{:>9.2?}] {name} first sync: {summary}", t.elapsed());
                    break;
                }
                Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(3)).await,
                Err(e) => bail!("{name} sync: {e}"),
            }
        }
    }
    // The hub subscribes back so member-authored chunks flow to it.
    for (id, name) in [(p_id_bytes.clone(), "phone"), (b_id_bytes.clone(), "bob")] {
        let h = l
            .call_sync_start(acc, id, part.clone(), true)
            .await?
            .map_err(|e| format_err!("laptop sync-start({name}): {e}"))?;
        loop {
            match l.call_sync_status(acc, h).await? {
                Ok(Some(_)) => break,
                Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(3)).await,
                Err(e) => bail!("laptop sync({name}): {e}"),
            }
        }
    }

    // Wait until both members can decrypt the creation chunk (revision 1).
    // This proves the bridge delivered doc membership + epoch material, so
    // subsequent subscription pushes pass the members' policy checks — a
    // push rejected by a not-yet-informed policy is not redelivered.
    for (t, name) in [(pt, "phone"), (bt, "bob")] {
        let start = Instant::now();
        let mut ok = false;
        for _ in 0..2000 {
            let rev = t
                .call_revision(acc)
                .await?
                .map_err(|e| format_err!("{name} revision: {e}"))?;
            if rev >= 1 {
                println!(
                    "[{:>9.2?}] {name} decrypted the creation chunk (revision {rev})",
                    start.elapsed()
                );
                ok = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        if !ok {
            bail!("{name} never decrypted the creation chunk");
        }
    }

    // 3. Tasks flow: laptop authors two.
    let milk = step!("laptop.tasks.add('buy milk')", lt.call_add(acc, "buy milk".into()));
    let _demo = step!(
        "laptop.tasks.add('write demo')",
        lt.call_add(acc, "write demo".into())
    );
    let items = wait_items(acc, pt, "phone sees both tasks", |i| i.len() == 2).await?;
    println!("            phone: {}", render(&items));
    wait_items(acc, bt, "bob sees both tasks", |i| i.len() == 2).await?;

    // 4. A real concurrency fork: phone toggles while laptop adds, both
    // from the same frontier; sync merges; phone's next change has two
    // parents.
    step!(
        "phone.tasks.set-completed('buy milk') [concurrent]",
        pt.call_set_completed(acc, milk.clone(), true)
    );
    step!(
        "laptop.tasks.add('laptop task') [concurrent]",
        lt.call_add(acc, "laptop task".into())
    );
    wait_items(acc, pt, "phone converged on fork", |i| {
        i.len() == 3 && i.iter().any(|x| x.title == "buy milk" && x.completed)
    })
    .await?;
    step!(
        "phone.tasks.add('phone task') [merges the fork]",
        pt.call_add(acc, "phone task".into())
    );

    let want4 = |i: &[TodoItem]| {
        i.len() == 4 && i.iter().any(|x| x.title == "buy milk" && x.completed)
    };
    let li = wait_items(acc, lt, "laptop converged (4 tasks)", want4).await?;
    let pi = wait_items(acc, pt, "phone converged (4 tasks)", want4).await?;
    let bi = wait_items(acc, bt, "bob converged (4 tasks)", want4).await?;
    if !same(&li, &pi) || !same(&pi, &bi) {
        bail!("replicas diverged:\n  laptop {li:?}\n  phone {pi:?}\n  bob {bi:?}");
    }
    println!("            all: {}", render(&li));

    let (chunks, max_parents) = step!("laptop.chunk-stats", l.call_chunk_stats(acc, part.clone()));
    println!("            chunks={chunks}, max-parents={max_parents}");
    if max_parents < 2 {
        bail!("expected a merge chunk with >= 2 parents (the DAG assertion)");
    }

    // 5. Collaborator edit propagates.
    let demo_id = bi
        .iter()
        .find(|x| x.title == "write demo")
        .map(|x| x.id.clone())
        .ok_or_else(|| format_err!("bob lost 'write demo'"))?;
    step!(
        "bob.tasks.set-completed('write demo')",
        bt.call_set_completed(acc, demo_id, true)
    );
    wait_items(acc, lt, "laptop sees bob's toggle", |i| {
        i.iter().any(|x| x.title == "write demo" && x.completed)
    })
    .await?;

    // 6. The bucket path (G4): the same envelope bytes, a second sync
    // surface. Laptop configures the store and grants K_p to every
    // member individual; the TABLET — which has never touched the wire —
    // cold-boots from the bucket alone.
    for (d, name, ak, sk) in [
        (l, "laptop", s3.access.as_str(), s3.secret.as_str()),
        (p, "phone ", s3.access.as_str(), s3.secret.as_str()),
        (tb, "tablet", s3.access.as_str(), s3.secret.as_str()),
        (b, "bob   ", "", ""),
    ] {
        d.call_init_store(
            acc,
            StoreConfig::S3(S3Config {
                endpoint: s3.endpoint.clone(),
                bucket: s3.bucket.clone(),
                access_key: ak.to_string(),
                secret_key: sk.to_string(),
            }),
        )
        .await?
        .map_err(|e| format_err!("{name} init-store: {e}"))?;
    }
    println!("            stores configured (bob: pull-only, no creds)");
    step!("laptop.ensure-bucket", l.call_ensure_bucket(acc));
    for (member, name) in [
        (l_id_bytes.clone(), "laptop"),
        (p_id_bytes.clone(), "phone"),
        (t_id_bytes.clone(), "tablet"),
        (b_id_bytes.clone(), "bob"),
    ] {
        // S3 returns no capability: the K_p sits at a location the
        // member derives. (Dropbox returns the minted pickup link.)
        let _ = step!(
            format!("laptop.store-grant({name})"),
            l.call_store_grant(acc, part.clone(), member)
        );
    }
    let summary = step!("laptop.bucket-flush", l.call_bucket_flush(acc, part.clone()));
    println!("            {summary}");

    // Cold start: the tablet joins from the bucket alone.
    let summary = step!(
        "tablet.bucket-pull [cold start, zero connections]",
        tb.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    let ti = wait_items(acc, tt, "tablet reads the full task list from the bucket", |i| {
        i.len() == 4
            && i.iter().any(|x| x.title == "buy milk" && x.completed)
            && i.iter().any(|x| x.title == "write demo" && x.completed)
    })
    .await?;
    let li_now = lt
        .call_items(acc)
        .await?
        .map_err(|e| format_err!("laptop items: {e}"))?;
    if !same(&ti, &li_now.items) {
        bail!(
            "tablet's bucket view diverges from laptop's live view:\n  tablet {ti:?}\n  laptop {:?}",
            li_now.items
        );
    }
    println!("            tablet == laptop, via bucket only");

    // 7. Cold authoring: the tablet writes through the bucket; the DAG
    // flows bucket -> laptop -> live wire -> phone and bob.
    step!(
        "tablet.tasks.add('tablet task') [cold author]",
        tt.call_add(acc, "tablet task".into())
    );
    let summary = step!("tablet.bucket-flush", tb.call_bucket_flush(acc, part.clone()));
    println!("            {summary}");
    let summary = step!(
        "laptop.bucket-pull",
        l.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    wait_items(acc, lt, "laptop sees the tablet task (via bucket)", |i| i.len() == 5).await?;
    wait_items(acc, pt, "phone sees the tablet task (bucket -> laptop -> wire)", |i| {
        i.len() == 5
    })
    .await?;
    wait_items(acc, bt, "bob sees the tablet task", |i| i.len() == 5).await?;

    // 8. Revocation, flavor 1 — collaborator: revoke BOB'S GROUP from the
    // doc AND his K_p from the bucket (the name-key epoch rotates with
    // the BeeKEM epoch). Bob is cut off on both surfaces.
    step!(
        "laptop.kh-revoke-member(bob-group)",
        l.call_kh_revoke_member(acc, part.clone(), bob_g.clone())
    );
    let note = step!(
        "laptop.store-revoke(bob)",
        l.call_store_revoke(acc, part.clone(), b_id_bytes.clone())
    );
    println!("            {note}");
    step!(
        "laptop.tasks.add('secret task') [post-revocation]",
        lt.call_add(acc, "secret task".into())
    );
    let summary = step!("laptop.bucket-flush", l.call_bucket_flush(acc, part.clone()));
    println!("            {summary}");
    wait_items(acc, pt, "phone sees the post-revocation task (rode the rotation)", |i| {
        i.len() == 6 && i.iter().any(|x| x.title == "secret task")
    })
    .await?;
    let summary = step!(
        "tablet.bucket-pull [rides the rotation via K_p republish]",
        tb.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    wait_items(acc, tt, "tablet sees the post-revocation task", |i| {
        i.len() == 6 && i.iter().any(|x| x.title == "secret task")
    })
    .await?;

    // Bob: the live surface must never show it, and the bucket surface
    // must refuse at the K_p (deleted; nothing else is locatable).
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let snap = bt
        .call_items(acc)
        .await?
        .map_err(|e| format_err!("bob items: {e}"))?;
    if snap.items.iter().any(|x| x.title == "secret task") {
        bail!("REVOCATION FAILURE: bob sees the secret task");
    }
    if snap.items.len() != 5 {
        bail!("bob's view changed unexpectedly: {:?}", snap.items);
    }
    match b
        .call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
        .await?
    {
        Err(e) if e.contains("kp missing") => {
            println!("            bob.bucket-pull refused: {e}");
        }
        Err(e) => bail!("bob's pull failed for the wrong reason: {e}"),
        Ok(s) => bail!("REVOCATION FAILURE: bob's bucket pull succeeded: {s}"),
    }
    let b_stats = b.call_stats(acc).await?;
    println!("            bob still sees 5 tasks; {b_stats}");

    // 9. Revocation, flavor 2 — lost phone: revoke the PHONE from Alice's
    // user group. Same mechanic, different node of the delegation graph.
    step!(
        "laptop.kh-revoke-from-group(alice-group, phone) [lost phone]",
        l.call_kh_revoke_from_group(acc, alice_g.clone(), p_id_bytes.clone())
    );
    step!(
        "laptop.tasks.add('post-lost-phone task')",
        lt.call_add(acc, "post-lost-phone task".into())
    );
    wait_items(acc, lt, "laptop sees all 7 tasks", |i| i.len() == 7).await?;
    let summary = step!("laptop.bucket-flush", l.call_bucket_flush(acc, part.clone()));
    println!("            {summary}");
    let summary = step!(
        "tablet.bucket-pull",
        tb.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    wait_items(acc, tt, "tablet sees all 7 tasks", |i| i.len() == 7).await?;

    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let snap = pt
        .call_items(acc)
        .await?
        .map_err(|e| format_err!("phone items: {e}"))?;
    if snap.items.iter().any(|x| x.title == "post-lost-phone task") {
        bail!("LOST-PHONE FAILURE: the revoked phone reads the new task");
    }
    if snap.items.len() != 6 {
        bail!("phone's view changed unexpectedly: {:?}", snap.items);
    }
    let p_stats = p.call_stats(acc).await?;
    println!("            phone still sees 6 tasks; {p_stats}");

    // 10. G5: restart from the identity bundle. Laptop exports the
    // sealed bundle with two keyslots — an argon2id passphrase (the
    // downloadable-file wrap) and a raw 32-byte secret standing in for
    // a passkey-PRF output. A fresh instance restores from the bundle
    // plus the bucket: identity, epochs, and the full task list.
    let prf_secret: Vec<u8> = (0..32u8).collect(); // obviously-synthetic PRF stand-in
    let bundle = step!(
        "laptop.identity-export(passphrase slot + prf slot)",
        l.call_identity_export(
            acc,
            "alice-laptop".into(),
            Some("correct horse battery staple".into()),
            Some(prf_secret.clone())
        )
    );
    println!("            bundle: {} bytes, 2 keyslots", bundle.len());

    // Wrong passphrase must fail before any state is built.
    match l2
        .call_identity_import(acc, bundle.clone(), Some("wrong horse".into()), None)
        .await?
    {
        Err(e) => println!("            wrong passphrase refused: {e}"),
        Ok(_) => bail!("SLOT FAILURE: wrong passphrase opened the bundle"),
    }

    let restored = step!(
        "laptop2.identity-import(passphrase) [restart]",
        l2.call_identity_import(
            acc,
            bundle.clone(),
            Some("correct horse battery staple".into()),
            None
        )
    );
    if restored != l_id {
        bail!("restored identity differs: {restored} != {l_id}");
    }
    println!("            restored identity == laptop identity");
    l2.call_init_store(
        acc,
        StoreConfig::S3(S3Config {
            endpoint: s3.endpoint.clone(),
            bucket: s3.bucket.clone(),
            access_key: s3.access.clone(),
            secret_key: s3.secret.clone(),
        }),
    )
    .await?
    .map_err(|e| format_err!("laptop2 init-store: {e}"))?;
    let summary = step!(
        "laptop2.bucket-pull [rehydrate: bundle + bucket only]",
        l2.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    wait_items(acc, l2t, "laptop2 reads all 7 tasks", |i| i.len() == 7).await?;

    // The restored device can still AUTHOR (its group-encryption leaf
    // secrets survived the archive) and others accept the result.
    step!(
        "laptop2.tasks.add('post-restart task')",
        l2t.call_add(acc, "post-restart task".into())
    );
    let summary = step!("laptop2.bucket-flush", l2.call_bucket_flush(acc, part.clone()));
    println!("            {summary}");
    let summary = step!(
        "tablet.bucket-pull",
        tb.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    wait_items(acc, tt, "tablet sees the restored device's task (8 total)", |i| {
        i.len() == 8
    })
    .await?;

    // The PRF-shaped slot opens the same bundle.
    let restored3 = step!(
        "laptop3.identity-import(prf slot)",
        l3.call_identity_import(acc, bundle, None, Some(prf_secret))
    );
    if restored3 != l_id {
        bail!("prf-slot restore differs: {restored3} != {l_id}");
    }
    println!("            prf-shaped slot opens the same bundle");

    for (name, d) in [("laptop", l), ("tablet", tb), ("laptop2", l2)] {
        let s = d.call_stats(acc).await?;
        println!("{name}: {s}");
    }
    println!("\nSPIKE PASSED");
    Ok(())
}
