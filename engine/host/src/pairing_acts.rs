//! Headless pairing + user-system acts (PAIRING.md §6).
//!
//! Six behaviours, each asserted rather than printed: a full pairing over
//! the local relay with the profile and a later mark reaching the new
//! device; the short authentication string agreeing on both sides; a
//! joiner refusing a commitment that does not open; a second claim on the
//! same code being refused and the offer burned; an offer expiring; two
//! devices picking the same petname concurrently and repairing to
//! byte-identical state with an announcement on both; and a revoked
//! device re-pairing as a NEW individual.
//!
//! The negative acts run in their own `Store` so their guest-side
//! verification hooks (`PM_PAIR_FAULT`, `PM_PAIR_TTL_MS`) cannot leak
//! into the positive ones.

use std::time::{Duration, Instant};

use wasmtime::component::Accessor;
use wasmtime::{bail, format_err, Result};

use crate::bindings::exports::polymorph::engine::driver::{
    Guest as Driver, PairAddState, PairJoinState, UsEvent, UsMark, UsProfile,
};
use crate::Ctx;

const POLLS: u32 = 4000;
const POLL_MS: u64 = 5;

fn ok(label: &str, t: Instant) {
    println!("[{:>9.2?}] {label}", t.elapsed());
}

async fn wait_join(
    acc: &Accessor<Ctx>,
    d: &Driver,
    what: &str,
    want: impl Fn(&PairJoinState) -> bool,
) -> Result<PairJoinState> {
    let t = Instant::now();
    let mut last = None;
    for _ in 0..POLLS {
        let state = d
            .call_pair_join_status(acc)
            .await?
            .map_err(|e| format_err!("{what}: join-status: {e}"))?;
        if want(&state) {
            ok(what, t);
            return Ok(state);
        }
        last = Some(describe_join(&state));
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    bail!("{what}: never reached (last state: {last:?})")
}

async fn wait_add(
    acc: &Accessor<Ctx>,
    d: &Driver,
    what: &str,
    want: impl Fn(&PairAddState) -> bool,
) -> Result<PairAddState> {
    let t = Instant::now();
    let mut last = None;
    for _ in 0..POLLS {
        let state = d
            .call_pair_add_status(acc)
            .await?
            .map_err(|e| format_err!("{what}: add-status: {e}"))?;
        if want(&state) {
            ok(what, t);
            return Ok(state);
        }
        last = Some(describe_add(&state));
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    bail!("{what}: never reached (last state: {last:?})")
}

fn describe_join(s: &PairJoinState) -> String {
    match s {
        PairJoinState::Waiting => "waiting".into(),
        PairJoinState::Claimed(sas) => format!("claimed({sas})"),
        PairJoinState::ConfirmedWaiting => "confirmed-waiting".into(),
        PairJoinState::Enrolled(_) => "enrolled".into(),
        PairJoinState::Expired => "expired".into(),
        PairJoinState::Failed(e) => format!("failed({e})"),
    }
}

fn describe_add(s: &PairAddState) -> String {
    match s {
        PairAddState::Connecting => "connecting".into(),
        PairAddState::SasReady(sas) => format!("sas-ready({sas})"),
        PairAddState::WaitingPeer => "waiting-peer".into(),
        PairAddState::Enrolled => "enrolled".into(),
        PairAddState::Failed(e) => format!("failed({e})"),
    }
}

/// Run one pairing ceremony to completion and return
/// `(sas, user-group-id, user-system-partition-id)`.
async fn pair(
    acc: &Accessor<Ctx>,
    adder: &Driver,
    joiner: &Driver,
    device_name: &str,
) -> Result<(String, Vec<u8>, Vec<u8>)> {
    let offer = joiner
        .call_pair_join_start(acc)
        .await?
        .map_err(|e| format_err!("pair-join-start: {e}"))?;
    if offer.code.len() != 79 {
        bail!(
            "pairing code is {} chars, contract says 79: {}",
            offer.code.len(),
            offer.code
        );
    }
    // The trusted device consumes the code exactly as a user would retype
    // it off the other screen: grouped in fours.
    let typed = offer
        .code
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .collect::<Vec<_>>()
        .join(" ");
    adder
        .call_pair_add_start(acc, typed)
        .await?
        .map_err(|e| format_err!("pair-add-start: {e}"))?;

    let join_state = wait_join(acc, joiner, "joiner shows the SAS", |s| {
        !matches!(s, PairJoinState::Waiting)
    })
    .await?;
    let add_state = wait_add(acc, adder, "adder shows the SAS", |s| {
        !matches!(s, PairAddState::Connecting)
    })
    .await?;
    let (PairJoinState::Claimed(sas_j), PairAddState::SasReady(sas_a)) = (&join_state, &add_state)
    else {
        bail!(
            "ceremony did not reach the SAS: joiner {}, adder {}",
            describe_join(&join_state),
            describe_add(&add_state)
        );
    };
    // The whole point of the ceremony: two users read the same string.
    if sas_j != sas_a {
        bail!("SAS MISMATCH: joiner {sas_j} != adder {sas_a}");
    }
    if sas_j.len() != 6 || !sas_j.chars().all(|c| c.is_ascii_digit()) {
        bail!("SAS is not six decimal digits: {sas_j}");
    }
    println!("            SAS agrees on both sides ({sas_j}), six digits");

    joiner
        .call_pair_join_confirm(acc)
        .await?
        .map_err(|e| format_err!("pair-join-confirm: {e}"))?;
    adder
        .call_pair_add_confirm(acc, device_name.to_string())
        .await?
        .map_err(|e| format_err!("pair-add-confirm: {e}"))?;

    let enrolled = wait_join(acc, joiner, "joiner enrolled", |s| {
        matches!(s, PairJoinState::Enrolled(_) | PairJoinState::Failed(_))
    })
    .await?;
    let PairJoinState::Enrolled(enrollment) = enrolled else {
        bail!("joiner did not enrol: {}", describe_join(&enrolled));
    };
    wait_add(acc, adder, "adder enrolled", |s| {
        matches!(s, PairAddState::Enrolled | PairAddState::Failed(_))
    })
    .await?;
    Ok((
        sas_j.clone(),
        enrollment.user_group_id,
        enrollment.partition_id,
    ))
}

/// Wire subduction between two paired devices and subscribe both ways to
/// the user-system tree.
async fn wire_us(
    acc: &Accessor<Ctx>,
    hub: (&Driver, &str, &[u8], &str),
    member: (&Driver, &str, &[u8]),
    tree: &[u8],
    relay: &str,
) -> Result<()> {
    let (h, h_name, h_id, h_ep) = hub;
    let (m, m_name, m_id) = member;
    crate::connect(acc, (m, m_name, h_id), (h, h_name, h_ep), relay).await?;
    for (d, name, peer) in [(m, m_name, h_id), (h, h_name, m_id)] {
        let handle = d
            .call_sync_start(acc, peer.to_vec(), tree.to_vec(), true)
            .await?
            .map_err(|e| format_err!("{name} sync-start: {e}"))?;
        for _ in 0..POLLS {
            match d.call_sync_status(acc, handle).await? {
                Ok(Some(_)) => break,
                Ok(None) => tokio::time::sleep(Duration::from_millis(3)).await,
                Err(e) => bail!("{name} sync: {e}"),
            }
        }
    }
    Ok(())
}

async fn wait_marks(
    acc: &Accessor<Ctx>,
    d: &Driver,
    what: &str,
    want: impl Fn(&[UsMark]) -> bool,
) -> Result<Vec<UsMark>> {
    let t = Instant::now();
    let mut last = None;
    for _ in 0..POLLS {
        match d.call_us_marks_list(acc).await? {
            Ok(marks) => {
                if want(&marks) {
                    ok(what, t);
                    return Ok(marks);
                }
                last = Some(format!("{} marks {marks:?}", marks.len()));
            }
            Err(e) => last = Some(e),
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    bail!("{what}: never held (last: {last:?})")
}

fn same_marks(a: &[UsMark], b: &[UsMark]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.provenance == y.provenance
                && x.petname == y.petname
                && x.icon == y.icon
                && x.nickname == y.nickname
                && x.created_at == y.created_at
                && x.needs_reconfirm == y.needs_reconfirm
        })
}

fn describe_events(events: &[UsEvent]) -> Vec<String> {
    events
        .iter()
        .map(|e| match e {
            UsEvent::ProfileChanged => "profile-changed".to_string(),
            UsEvent::MarkAdded(p) => format!("mark-added({p})"),
            UsEvent::MarkChanged(p) => format!("mark-changed({p})"),
            UsEvent::MarkConflictRepaired((p, k)) => format!("mark-conflict-repaired({p},{k})"),
            UsEvent::DeviceAdded(n) => format!("device-added({n})"),
            UsEvent::DeviceRevoked(n) => format!("device-revoked({n})"),
        })
        .collect()
}

/// The positive act set. Each gate is recorded rather than aborting the
/// run, so one blocked gate does not hide the state of the others; the
/// caller fails if any of them failed.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn positive_acts(
    acc: &Accessor<Ctx>,
    laptop: crate::bindings::Engine,
    phone: crate::bindings::Engine,
    stranger: crate::bindings::Engine,
    rejoin: crate::bindings::Engine,
    relay: String,
) -> Result<()> {
    let l: &Driver = laptop.polymorph_engine_driver();
    let p: &Driver = phone.polymorph_engine_driver();
    let x: &Driver = stranger.polymorph_engine_driver();
    let r: &Driver = rejoin.polymorph_engine_driver();

    let l_id = l.call_init(acc, false).await?.map_err(|e| format_err!("laptop init: {e}"))?;
    let p_id = p.call_init(acc, false).await?.map_err(|e| format_err!("phone init: {e}"))?;
    x.call_init(acc, false).await?.map_err(|e| format_err!("stranger init: {e}"))?;
    r.call_init(acc, false).await?.map_err(|e| format_err!("rejoin init: {e}"))?;
    let l_bytes = hex::decode(&l_id)?;
    let p_bytes = hex::decode(&p_id)?;

    let l_ep = l.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    for d in [p, x, r] {
        d.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    }

    let group = l
        .call_user_create(
            acc,
            UsProfile {
                display_name: "Alice".into(),
                // Palette INDEX, not an angle (PAIRING.md §4).
                hue: 3,
                icon: None,
            },
        )
        .await?
        .map_err(|e| format_err!("user-create: {e}"))?;
    println!("            user group created, user-system partition sealed");

    let mut results: Vec<(&str, std::result::Result<(), String>)> = Vec::new();

    // --- gates 1+2: the ceremony itself, and the SAS agreeing ---
    let (sas, joined_group, partition) = pair(acc, l, p, "alice phone").await?;
    results.push(("full pair over the local relay", Ok(())));
    // `pair` compares the two sides' strings and bails on any mismatch,
    // on a non-six-digit string, or on a non-numeric one, so reaching
    // here IS the assertion; recorded separately because it is the
    // property the whole ceremony exists to establish.
    results.push((
        "SAS equal on both sides",
        if sas.len() == 6 {
            Ok(())
        } else {
            Err(format!("SAS is not six digits: {sas}"))
        },
    ));
    results.push((
        "enrollment carries the adder's own user group",
        if joined_group == group {
            Ok(())
        } else {
            Err("enrollment carried a different user group than the adder holds".into())
        },
    ));

    // Local-echo suppression: the adder wrote the devices entry itself,
    // so it must not be told about it.
    let l_events = l.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?;
    results.push((
        "adder receives no event for its own write",
        if l_events
            .iter()
            .any(|e| matches!(e, UsEvent::DeviceAdded(n) if n == "alice phone"))
        {
            Err(format!(
                "the adder was announced its own devices write: {:?}",
                describe_events(&l_events)
            ))
        } else {
            Ok(())
        },
    ));

    let devices = l.call_us_devices_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    results.push((
        "the new device is recorded in us-devices-list",
        if devices.iter().any(|d| d.name == "alice phone" && !d.revoked) {
            Ok(())
        } else {
            Err(format!(
                "missing: {:?}",
                devices.iter().map(|d| d.name.clone()).collect::<Vec<_>>()
            ))
        },
    ));

    // The joiner needs the wire to pull the partition it just adopted.
    wire_us(
        acc,
        (l, "laptop", &l_bytes, l_ep.as_str()),
        (p, "phone", &p_bytes),
        &partition,
        &relay,
    )
    .await?;

    let adoption = act_adoption(acc, l, p).await;
    let adopted = adoption.is_ok();
    results.push((
        "joiner adopts the profile; a later mark reaches it",
        adoption.map_err(|e| e.to_string()),
    ));

    if adopted {
        results.push((
            "concurrent same-petname and same-icon repairs identically on both devices",
            act_repair(acc, l, p).await.map_err(|e| e.to_string()),
        ));
    } else {
        results.push((
            "concurrent same-petname and same-icon repairs identically on both devices",
            Err("not reached: the joiner never became a reader of the partition".into()),
        ));
    }

    results.push((
        "a second claim on the same code is refused",
        act_second_claim(acc, l, x, r).await.map_err(|e| e.to_string()),
    ));

    results.push((
        "revoke a device, then re-pair the same hardware as a NEW individual",
        act_revoke_and_repair(acc, l, r, &p_bytes, &group, &partition)
            .await
            .map_err(|e| e.to_string()),
    ));

    println!("\n--- positive pairing gates ---");
    let mut failed = 0;
    for (name, outcome) in &results {
        match outcome {
            Ok(()) => println!("  PASS  {name}"),
            Err(e) => {
                failed += 1;
                println!("  FAIL  {name}\n          {e}");
            }
        }
    }
    if failed > 0 {
        bail!("{failed} positive pairing gate(s) failed");
    }
    println!("\nPAIRING ACTS (positive) PASSED");
    Ok(())
}

/// Adoption + marks propagation: the joiner takes on the account's
/// profile, is told about it (#22: remotely-caused changes are
/// announced), and sees a mark written afterwards on the other device.
async fn act_adoption(acc: &Accessor<Ctx>, l: &Driver, p: &Driver) -> Result<()> {
    l.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://recipes.example/".into(),
            petname: "Recipes".into(),
            icon: "🥕".into(),
            nickname: None,
            created_at: 1_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("us-mark-put: {e}"))?;

    let t = Instant::now();
    let mut adopted = false;
    for _ in 0..POLLS {
        let profile = p.call_us_profile_get(acc).await?.map_err(|e| format_err!("{e}"))?;
        if profile.display_name == "Alice" && profile.hue == 3 {
            adopted = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    if !adopted {
        // Which half is broken: can the joiner WRITE into the doc (i.e.
        // does it hold a usable CGKA position at all), and if so can the
        // founder read what it wrote?
        // Diagnostic, failure path only: which DIRECTION is broken. It
        // writes, which is why it never runs on a passing gate.
        match p
            .call_us_profile_set(
                acc,
                UsProfile { display_name: "from-joiner".into(), hue: 9, icon: None },
            )
            .await?
        {
            Ok(()) => {
                println!(
                    "            DIAGNOSTIC: the joiner CAN encrypt into the partition \
                     (it holds a usable epoch of its own)"
                );
                let mut seen = false;
                for _ in 0..600 {
                    if let Ok(pr) = l.call_us_profile_get(acc).await? {
                        if pr.display_name == "from-joiner" { seen = true; break; }
                    }
                    tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
                }
                println!(
                    "            DIAGNOSTIC: founder reads the joiner's write = {seen} \
                     (the founder's own writes stay unreadable to the joiner)"
                );
            }
            Err(e) => println!("            DIAGNOSTIC: the joiner cannot encrypt either: {e}"),
        }
        bail!(
            "the joiner never became able to read the user-system partition \
             (every chunk stays undecryptable: see the report's finding on \
             enrolment into a doc that was sealed before the device joined)"
        );
    }
    ok("joiner adopted the profile (name + hue)", t);

    // Drains are destructive, and adoption plus the mark can land in the
    // SAME apply — so the announcements are ACCUMULATED across the act
    // rather than asserted against whichever drain happens to catch them.
    // (Splitting them was a latent assumption that the two arrive in
    // separate rounds; faster delivery merges them.)
    let mut announced: Vec<UsEvent> = Vec::new();
    announced.extend(p.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?);

    let devices = p.call_us_devices_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    if !devices.iter().any(|d| d.name == "alice phone" && !d.revoked) {
        bail!("the joiner does not see itself in us-devices-list");
    }

    let t = Instant::now();
    let mut seen_mark = false;
    for _ in 0..POLLS {
        let marks = p.call_us_marks_list(acc).await?.map_err(|e| format_err!("{e}"))?;
        announced.extend(p.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?);
        if marks.iter().any(|m| m.petname == "Recipes") {
            seen_mark = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    if !seen_mark {
        bail!("the mark written on the laptop never reached the phone");
    }
    ok("mark written on the laptop reaches the phone", t);

    if !announced.iter().any(|e| matches!(e, UsEvent::ProfileChanged)) {
        bail!(
            "adoption was not announced to the joiner: {:?}",
            describe_events(&announced)
        );
    }
    if !announced
        .iter()
        .any(|e| matches!(e, UsEvent::MarkAdded(prov) if prov == "https://recipes.example/"))
    {
        bail!(
            "the remote mark was not announced: {:?}",
            describe_events(&announced)
        );
    }
    println!("            joiner announcements: {:?}", describe_events(&announced));
    Ok(())
}

/// Two races against the same pair of devices, neither having seen the
/// other's write before the merge:
///
///  1. Two devices name different sites the same thing (petname
///     collision, case-insensitive). Both must land on identical
///     repaired state — announced, never silent, never blocking. The
///     loser keeps its petname bytes and is flagged for reconfirm.
///  2. Two devices mark different provenances with the SAME pet icon
///     (icon collision, #22). The engine cannot invent a replacement
///     glyph (the curated vocabulary is the visor's), so the loser's
///     icon is cleared to "" and flagged for reconfirm — the visor
///     re-offers its picker on reconfirm.
async fn act_repair(acc: &Accessor<Ctx>, l: &Driver, p: &Driver) -> Result<()> {
    let _ = l.call_us_events(acc).await?;
    let _ = p.call_us_events(acc).await?;

    // --- race 1: same petname, DIFFERENT icons (isolates the petname
    // repair from the icon repair below) ---
    l.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://notes-a.example/".into(),
            petname: "Notes".into(),
            icon: "🍇".into(),
            nickname: None,
            created_at: 2_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("us-mark-put(a): {e}"))?;
    p.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://notes-b.example/".into(),
            // Case-insensitive collision, deliberately: "notes" and
            // "Notes" are the same name to a person.
            petname: "notes".into(),
            icon: "🍎".into(),
            nickname: None,
            created_at: 3_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("us-mark-put(b): {e}"))?;

    let want = |m: &[UsMark]| {
        m.len() == 3
            && m.iter()
                .any(|x| x.provenance == "https://notes-b.example/" && x.needs_reconfirm)
            && m.iter()
                .any(|x| x.provenance == "https://notes-a.example/" && x.petname == "Notes")
    };
    let l_marks = wait_marks(acc, l, "laptop repaired the petname collision", want).await?;
    let p_marks = wait_marks(acc, p, "phone repaired the petname collision", want).await?;
    if !same_marks(&l_marks, &p_marks) {
        bail!("PETNAME REPAIR DIVERGED:\n  laptop {l_marks:?}\n  phone  {p_marks:?}");
    }
    let loser = p_marks
        .iter()
        .find(|m| m.provenance == "https://notes-b.example/")
        .ok_or_else(|| format_err!("petname loser mark vanished"))?;
    if loser.petname != "notes" {
        bail!("the petname loser lost its name bytes: {}", loser.petname);
    }
    println!("            older mark keeps petname; younger loser flagged for reconfirm");

    for (d, name) in [(l, "laptop"), (p, "phone")] {
        let mut announced = Vec::new();
        let t = Instant::now();
        for _ in 0..POLLS {
            announced.extend(d.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?);
            if announced.iter().any(
                |e| matches!(e, UsEvent::MarkConflictRepaired((_, k)) if k == "petname"),
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        }
        if !announced
            .iter()
            .any(|e| matches!(e, UsEvent::MarkConflictRepaired((_, k)) if k == "petname"))
        {
            bail!(
                "{name} repaired the petname collision silently — no announcement: {:?}",
                describe_events(&announced)
            );
        }
        ok(&format!("{name} announced the petname repair"), t);
        println!("            {name}: {:?}", describe_events(&announced));
    }

    // --- race 2: DIFFERENT petnames, same icon (#22 icon collision) ---
    l.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://icon-a.example/".into(),
            petname: "Alpha".into(),
            icon: "🐝".into(),
            nickname: None,
            created_at: 4_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("us-mark-put(icon-a): {e}"))?;
    p.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://icon-b.example/".into(),
            petname: "Bravo".into(),
            icon: "🐝".into(),
            nickname: None,
            created_at: 5_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("us-mark-put(icon-b): {e}"))?;

    let icon_want = |m: &[UsMark]| {
        m.len() == 5
            && m.iter()
                .any(|x| x.provenance == "https://icon-b.example/" && x.needs_reconfirm)
            && m.iter()
                .any(|x| x.provenance == "https://icon-a.example/" && x.icon == "🐝")
    };
    let l_marks = wait_marks(acc, l, "laptop repaired the icon collision", icon_want).await?;
    let p_marks = wait_marks(acc, p, "phone repaired the icon collision", icon_want).await?;
    if !same_marks(&l_marks, &p_marks) {
        bail!("ICON REPAIR DIVERGED:\n  laptop {l_marks:?}\n  phone  {p_marks:?}");
    }
    let icon_loser = p_marks
        .iter()
        .find(|m| m.provenance == "https://icon-b.example/")
        .ok_or_else(|| format_err!("icon loser mark vanished"))?;
    // The engine cannot invent a replacement glyph — the loser is
    // cleared to "" (unmarked), not reassigned to some other glyph.
    if !icon_loser.icon.is_empty() {
        bail!(
            "the icon loser was not cleared: still {:?}",
            icon_loser.icon
        );
    }
    if icon_loser.petname != "Bravo" {
        bail!("the icon loser lost its petname bytes: {}", icon_loser.petname);
    }
    println!(
        "            older mark keeps icon 🐝; younger loser cleared to \"\" and flagged for reconfirm"
    );

    for (d, name) in [(l, "laptop"), (p, "phone")] {
        let mut announced = Vec::new();
        let t = Instant::now();
        for _ in 0..POLLS {
            announced.extend(d.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?);
            if announced
                .iter()
                .any(|e| matches!(e, UsEvent::MarkConflictRepaired((_, k)) if k == "icon"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        }
        if !announced
            .iter()
            .any(|e| matches!(e, UsEvent::MarkConflictRepaired((_, k)) if k == "icon"))
        {
            bail!(
                "{name} repaired the icon collision silently — no announcement: {:?}",
                describe_events(&announced)
            );
        }
        ok(&format!("{name} announced the icon repair"), t);
        println!("            {name}: {:?}", describe_events(&announced));
    }
    Ok(())
}

/// A code that reaches a second party has leaked, so the offer dies
/// rather than continuing under a claim the user cannot audit.
async fn act_second_claim(
    acc: &Accessor<Ctx>,
    adder: &Driver,
    stranger: &Driver,
    joiner: &Driver,
) -> Result<()> {
    let offer = joiner
        .call_pair_join_start(acc)
        .await?
        .map_err(|e| format_err!("pair-join-start: {e}"))?;
    adder
        .call_pair_add_start(acc, offer.code.clone())
        .await?
        .map_err(|e| format_err!("first claim: {e}"))?;
    wait_add(acc, adder, "first claim binds the session", |s| {
        matches!(s, PairAddState::SasReady(_) | PairAddState::Failed(_))
    })
    .await?;
    stranger
        .call_pair_add_start(acc, offer.code)
        .await?
        .map_err(|e| format_err!("second claim start: {e}"))?;
    let second = wait_add(acc, stranger, "second claim refused", |s| {
        matches!(s, PairAddState::Failed(_))
    })
    .await?;
    let PairAddState::Failed(why) = &second else {
        unreachable!()
    };
    if !why.contains("already claimed") {
        bail!("the second claim failed for the wrong reason: {why}");
    }
    println!("            second claim: {why}");
    let burned = wait_join(acc, joiner, "the offer is burned on the joiner", |s| {
        matches!(s, PairJoinState::Failed(_))
    })
    .await?;
    println!("            joiner: {}", describe_join(&burned));
    for d in [adder, stranger, joiner] {
        let _ = d.call_pair_abort(acc).await?;
    }
    Ok(())
}

/// "Same hardware, new individual": a revoked device does not come back
/// as itself. It pairs again as a fresh principal, and the old entry
/// stays in the list, marked revoked.
async fn act_revoke_and_repair(
    acc: &Accessor<Ctx>,
    l: &Driver,
    rejoin: &Driver,
    revoked: &[u8],
    group: &[u8],
    partition: &[u8],
) -> Result<()> {
    l.call_us_device_revoke(acc, revoked.to_vec())
        .await?
        .map_err(|e| format_err!("us-device-revoke: {e}"))?;
    let devices = l.call_us_devices_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    if !devices.iter().any(|d| d.agent_id == revoked && d.revoked) {
        bail!("the revoked device is not marked revoked in us-devices-list");
    }
    println!("            phone revoked from the user group and marked in the devices list");

    let (_sas, group2, partition2) = pair(acc, l, rejoin, "alice phone (re-paired)").await?;
    if group2 != group {
        bail!("the re-pair enrolled into a different account");
    }
    // One lineage: enrollment no longer regenerates the doc, so ENROLL
    // carries the ORIGINAL partition id (PAIRING.md §2, §4b).
    if partition2 != partition {
        bail!("enrollment handed out a different partition than the account's own");
    }
    let devices = l.call_us_devices_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    let fresh = devices
        .iter()
        .find(|d| d.name == "alice phone (re-paired)")
        .ok_or_else(|| format_err!("the re-paired device is missing from the list"))?;
    if fresh.agent_id == revoked {
        bail!("the re-paired device reused the revoked individual");
    }
    if fresh.revoked {
        bail!("the re-paired device came back revoked");
    }
    println!("            re-paired as a NEW individual; the revoked entry is still recorded");
    Ok(())
}

/// Act 3: a joiner refuses a commitment that does not open.
///
/// The adder in this store runs with the verification hook set, so it
/// reveals a nonce it never committed to. That is exactly the move a
/// party grinding the 20-bit SAS would need, and the joiner must end the
/// ceremony rather than display a string.
pub(crate) async fn commitment_act(
    acc: &Accessor<Ctx>,
    adder: crate::bindings::Engine,
    joiner: crate::bindings::Engine,
    relay: String,
) -> Result<()> {
    let a: &Driver = adder.polymorph_engine_driver();
    let j: &Driver = joiner.polymorph_engine_driver();
    a.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    j.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    a.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    j.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    a.call_user_create(
        acc,
        UsProfile {
            display_name: "Alice".into(),
            hue: 3,
            icon: None,
        },
    )
    .await?
    .map_err(|e| format_err!("user-create: {e}"))?;

    let offer = j
        .call_pair_join_start(acc)
        .await?
        .map_err(|e| format_err!("pair-join-start: {e}"))?;
    a.call_pair_add_start(acc, offer.code)
        .await?
        .map_err(|e| format_err!("pair-add-start: {e}"))?;

    let state = wait_join(acc, j, "joiner refuses the bad commitment", |s| {
        matches!(s, PairJoinState::Failed(_) | PairJoinState::Claimed(_))
    })
    .await?;
    match state {
        PairJoinState::Failed(why) => {
            if !why.contains("commitment") {
                bail!("the joiner aborted for the wrong reason: {why}");
            }
            println!("            joiner: {why}");
        }
        other => bail!(
            "COMMITMENT FAILURE: the joiner accepted a nonce that does not open the commitment ({})",
            describe_join(&other)
        ),
    }
    println!("\nPAIRING ACT (commitment violation) PASSED");
    Ok(())
}

/// Act 4: an offer expires.
///
/// The store running this act carries a shortened TTL so the act is
/// seconds rather than two minutes; the expiry PATH is the same one the
/// contract's 120 s uses.
pub(crate) async fn expiry_act(
    acc: &Accessor<Ctx>,
    joiner: crate::bindings::Engine,
    relay: String,
    ttl_ms: u64,
) -> Result<()> {
    let j: &Driver = joiner.polymorph_engine_driver();
    j.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    j.call_iroh_bind(acc, relay).await?.map_err(|e| format_err!("{e}"))?;
    let offer = j
        .call_pair_join_start(acc)
        .await?
        .map_err(|e| format_err!("pair-join-start: {e}"))?;
    let state = j.call_pair_join_status(acc).await?.map_err(|e| format_err!("{e}"))?;
    if !matches!(state, PairJoinState::Waiting) {
        bail!("a fresh offer should be waiting, got {}", describe_join(&state));
    }
    println!("            offer minted, expires-ms={}", offer.expires_ms);
    tokio::time::sleep(Duration::from_millis(ttl_ms + 500)).await;
    let state = j.call_pair_join_status(acc).await?.map_err(|e| format_err!("{e}"))?;
    if !matches!(state, PairJoinState::Expired) {
        bail!(
            "an unclaimed offer past its expiry must report expired, got {}",
            describe_join(&state)
        );
    }
    println!("            unclaimed offer expired; a new offer mints a new token");
    println!("\nPAIRING ACT (offer expiry) PASSED");
    Ok(())
}

/// Post-seal add on the account's document: the boundary act.
///
/// Enrollment adds a device to the group long after the doc was sealed,
/// and this act pins what that device can and cannot reach on it. Since
/// regeneration retired there is only one lineage, so this is simply the
/// normal flow examined closely — which is the point: the boundary is a
/// property of every enrollment, not of a special configuration.
///
/// Two assertions, and the boundary between them is the point:
///
/// - **post-rotation content is readable** — the joiner opens the
///   envelope of a chunk the founder wrote after the add and the forced
///   rotation. Asserted at the keyhive/envelope level, because that is
///   where the access question lives.
/// - **pre-join content stays dark, by design** — BeeKEM adds are not
///   retroactive, and without the Envelope content format there are no
///   causal keys to walk back through. Asserted as EXPECTED-unreadable so
///   the act documents the boundary rather than leaving it folded into a
///   pass.
pub(crate) async fn post_seal_add_act(
    acc: &Accessor<Ctx>,
    founder: crate::bindings::Engine,
    joiner: crate::bindings::Engine,
    relay: String,
) -> Result<()> {
    let l: &Driver = founder.polymorph_engine_driver();
    let p: &Driver = joiner.polymorph_engine_driver();

    let l_id = l.call_init(acc, false).await?.map_err(|e| format_err!("founder init: {e}"))?;
    let p_id = p.call_init(acc, false).await?.map_err(|e| format_err!("joiner init: {e}"))?;
    let l_bytes = hex::decode(&l_id)?;
    let p_bytes = hex::decode(&p_id)?;
    let l_ep = l.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    p.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;

    l.call_user_create(
        acc,
        UsProfile { display_name: "Alice".into(), hue: 3, icon: None },
    )
    .await?
    .map_err(|e| format_err!("user-create: {e}"))?;

    // Pre-join content: written before the joiner exists at all.
    l.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://before.example/".into(),
            petname: "Before".into(),
            icon: "🐦".into(),
            nickname: None,
            created_at: 1_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("pre-join mark: {e}"))?;

    // Enrollment: same doc, joiner added long after the seal.
    let (_sas, _group, partition) = pair(acc, l, p, "late device").await?;
    wire_us(
        acc,
        (l, "founder", &l_bytes, l_ep.as_str()),
        (p, "joiner", &p_bytes),
        &partition,
        &relay,
    )
    .await?;

    // Baseline the joiner's envelope counter BEFORE the founder's
    // post-join write, so the assertion is "it opened THAT chunk" rather
    // than "it opened something at some point".
    let mut before = 0u32;
    for _ in 0..200 {
        let _ = p.call_us_marks_list(acc).await?;
        before = parse_stat(&p.call_stats(acc).await?, "us-decrypted");
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    println!("            joiner envelopes opened before the post-join write: {before}");

    // Post-join content, written after the add and the forced rotation
    // the enrollment path performs.
    l.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://after.example/".into(),
            petname: "After".into(),
            icon: "🦋".into(),
            nickname: None,
            created_at: 2_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("post-join mark: {e}"))?;

    // Assertion 1: the joiner opens envelopes written after it joined.
    let t = Instant::now();
    let mut opened = 0u32;
    let mut last = String::new();
    for _ in 0..POLLS {
        // Any us-* read drives the apply pipeline.
        let _ = p.call_us_marks_list(acc).await?;
        last = p.call_stats(acc).await?;
        opened = parse_stat(&last, "us-decrypted");
        if opened > before {
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    if opened <= before {
        bail!(
            "the late joiner never opened the post-rotation chunk on the \
             original doc (envelopes opened stayed at {before}) — the \
             event-delivery gap is back. joiner stats: {last}"
        );
    }
    ok(
        &format!(
            "late joiner opened the post-rotation chunk ({before} -> {opened} envelopes)"
        ),
        t,
    );
    println!("            joiner: {last}");

    // Set-level attribution (spikes/keyhive-addwedge): what the joiner
    // HOLDS versus what the founder would offer it, computed on the
    // founder at this instant. The earlier investigation compared op
    // COUNTS and found them equal; counts are not sets, and this is that
    // upgrade. Sampled AFTER the readability assertion above, so it can
    // never be the thing that makes the act pass.
    if std::env::var("PM_EVENT_DIFF").is_ok() {
        let authoritative = l
            .call_kh_export_card(acc, p_bytes.clone())
            .await?
            .map_err(|e| format_err!("founder export card: {e}"))?;
        // Reported by the guest as kinds and counts (never contents).
        p.call_kh_ingest_card(acc, authoritative)
            .await?
            .map_err(|e| format_err!("joiner ingest: {e}"))?;
    }

    // Assertion 2: the boundary has MOVED, and both halves are asserted.
    //
    // Pre-join chunks are sealed under an epoch this device will never
    // hold, so a direct decrypt of them must still fail — and they must
    // nevertheless materialize, because a readable descendant carries
    // their keys (PAIRING.md §4b). Materialization alone would not
    // distinguish the walk from a lucky epoch; the walk counter is what
    // makes "recovered where direct decrypt failed" observable, and the
    // engine increments it only for chunks whose direct decrypt failed.
    //
    // The pre-join ancestry here is the creation change plus the "Before"
    // mark: at least two chunks must come back through the walk.
    const PRE_JOIN_CHUNKS: u32 = 2;
    let t = Instant::now();
    let mut marks = Vec::new();
    let mut walked = 0u32;
    let mut last = String::new();
    for _ in 0..POLLS {
        marks = p.call_us_marks_list(acc).await?.map_err(|e| format_err!("{e}"))?;
        last = p.call_stats(acc).await?;
        walked = parse_stat(&last, "us-walked");
        if marks.iter().any(|m| m.petname == "Before") && walked >= PRE_JOIN_CHUNKS {
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    if !marks.iter().any(|m| m.petname == "Before") {
        bail!(
            "pre-join content did not materialize through the causal walk \
             (joiner sees {} mark(s); stats: {last})",
            marks.len()
        );
    }
    if walked < PRE_JOIN_CHUNKS {
        bail!(
            "pre-join content materialized WITHOUT the causal walk \
             (us-walked={walked}, expected at least {PRE_JOIN_CHUNKS}) — the act \
             would be passing for the wrong reason. stats: {last}"
        );
    }
    ok(
        &format!("pre-join content recovered by causal walk ({walked} chunk(s)) and materialized"),
        t,
    );
    println!("            joiner: {last}");

    println!("\nPAIRING ACT (post-seal add, original doc) PASSED");
    Ok(())
}

/// Pull one `name=<u32>` counter out of the driver's stats line.
fn parse_stat(stats: &str, name: &str) -> u32 {
    stats
        .split([';', ' '])
        .find_map(|field| field.strip_prefix(&format!("{name}=")))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

/// A late joiner materializes the account's FULL pre-join history.
///
/// This is the property the Envelope format buys (PAIRING.md §4b): the
/// joiner's epochs cannot open pre-join chunks, but the anchor chunk
/// written at enrollment carries its parents' keys, and each recovered
/// chunk carries its own parents' — so the whole ancestry unwinds from
/// one readable descendant.
///
/// `seed` varies arrival order across runs: how much history exists
/// before the join, whether the founder writes again before the joiner
/// first pulls, and whether the joiner is subscribed before or after that
/// write. The previous implementation of this area was order-dependent,
/// so order is the thing to vary.
pub(crate) async fn full_history_act(
    acc: &Accessor<Ctx>,
    founder: crate::bindings::Engine,
    joiner: crate::bindings::Engine,
    relay: String,
    seed: u32,
) -> Result<()> {
    let l: &Driver = founder.polymorph_engine_driver();
    let p: &Driver = joiner.polymorph_engine_driver();

    let l_id = l.call_init(acc, false).await?.map_err(|e| format_err!("founder init: {e}"))?;
    let p_id = p.call_init(acc, false).await?.map_err(|e| format_err!("joiner init: {e}"))?;
    let l_bytes = hex::decode(&l_id)?;
    let p_bytes = hex::decode(&p_id)?;
    let l_ep = l.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    p.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;

    l.call_user_create(
        acc,
        UsProfile { display_name: "Alice".into(), hue: 3, icon: None },
    )
    .await?
    .map_err(|e| format_err!("user-create: {e}"))?;

    // 1..=3 pre-join marks, plus a profile edit, so the ancestry the walk
    // must cover is several chunks deep and varies by seed.
    let depth = 1 + (seed % 3);
    for i in 0..depth {
        l.call_us_mark_put(
            acc,
            UsMark {
                provenance: format!("https://pre-{i}.example/"),
                petname: format!("Pre{i}"),
                icon: format!("{i}"),
                nickname: None,
                created_at: 1_000 + i as u64,
                needs_reconfirm: false,
            },
        )
        .await?
        .map_err(|e| format_err!("pre-join mark {i}: {e}"))?;
    }
    l.call_us_profile_set(
        acc,
        UsProfile { display_name: "Alice Renamed".into(), hue: 4, icon: None },
    )
    .await?
    .map_err(|e| format_err!("pre-join profile edit: {e}"))?;

    let (_sas, _group, partition) = pair(acc, l, p, "late device").await?;

    // Order variation: does the founder write again before the joiner is
    // wired, or after?
    let write_before_wire = seed.is_multiple_of(2);
    if write_before_wire {
        l.call_us_mark_put(
            acc,
            UsMark {
                provenance: "https://post.example/".into(),
                petname: "Post".into(),
                icon: "📮".into(),
                nickname: None,
                created_at: 5_000,
                needs_reconfirm: false,
            },
        )
        .await?
        .map_err(|e| format_err!("post-join mark: {e}"))?;
    }

    wire_us(
        acc,
        (l, "founder", &l_bytes, l_ep.as_str()),
        (p, "joiner", &p_bytes),
        &partition,
        &relay,
    )
    .await?;

    if !write_before_wire {
        l.call_us_mark_put(
            acc,
            UsMark {
                provenance: "https://post.example/".into(),
                petname: "Post".into(),
                icon: "📮".into(),
                nickname: None,
                created_at: 5_000,
                needs_reconfirm: false,
            },
        )
        .await?
        .map_err(|e| format_err!("post-join mark: {e}"))?;
    }

    // Everything the founder ever wrote must materialize on the joiner:
    // the pre-join marks, the pre-join profile EDIT (not just the initial
    // value), and the post-join mark.
    let want_all = move |m: &[UsMark]| {
        (0..depth).all(|i| m.iter().any(|x| x.petname == format!("Pre{i}")))
            && m.iter().any(|x| x.petname == "Post")
    };
    let marks = wait_marks(
        acc,
        p,
        &format!("seed {seed}: joiner materialized all {} pre-join mark(s) + the post-join one", depth),
        want_all,
    )
    .await?;
    let profile = p.call_us_profile_get(acc).await?.map_err(|e| format_err!("{e}"))?;
    if profile.display_name != "Alice Renamed" || profile.hue != 4 {
        bail!(
            "seed {seed}: the joiner did not materialize the pre-join profile EDIT \
             (sees {:?}/{})",
            profile.display_name,
            profile.hue
        );
    }
    println!(
        "            seed {seed}: {} marks, profile '{}' — full history via walk",
        marks.len(),
        profile.display_name
    );
    Ok(())
}

/// Concurrent writes from a device that did not see another device's
/// enrollment survive the merge — including a DELETION.
///
/// The value-copy handoff this replaces could resurrect a forgotten mark
/// (the copy was taken from a state that still contained it) and could
/// lose a rename (the copy carried the old name). With one document
/// lineage both are ordinary CRDT merges, and this act is the proof.
///
/// Driver limitation, stated exactly rather than overclaimed: there is no
/// disconnect verb, so this act cannot force a partition. What the
/// ordering DOES guarantee, and what is asserted below, is one direction:
/// the second device authors its three writes before the enrollment
/// writes exist at all, so it cannot have seen them. The other direction
/// — that the founder had not yet received the second device's writes
/// when it authored the enrollment entry — is NOT guaranteed here, since
/// a fast sync may deliver them first; it is reported, not asserted.
/// Either way the merge properties under test (a deletion that must not
/// resurrect, a rename that must not be lost) are exercised.
pub(crate) async fn partitioned_writer_act(
    acc: &Accessor<Ctx>,
    founder: crate::bindings::Engine,
    second: crate::bindings::Engine,
    joiner: crate::bindings::Engine,
    relay: String,
) -> Result<()> {
    let l: &Driver = founder.polymorph_engine_driver();
    let b: &Driver = second.polymorph_engine_driver();
    let c: &Driver = joiner.polymorph_engine_driver();

    let l_id = l.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    let b_id = b.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    c.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    let l_bytes = hex::decode(&l_id)?;
    let b_bytes = hex::decode(&b_id)?;
    let l_ep = l.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    b.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    c.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;

    l.call_user_create(
        acc,
        UsProfile { display_name: "Alice".into(), hue: 3, icon: None },
    )
    .await?
    .map_err(|e| format_err!("user-create: {e}"))?;
    for (prov, name, icon, at) in [
        ("https://keep.example/", "Keep", "1", 1_000u64),
        ("https://rename.example/", "OldName", "2", 1_100),
        ("https://forget.example/", "Doomed", "6", 1_200),
    ] {
        l.call_us_mark_put(
            acc,
            UsMark {
                provenance: prov.into(),
                petname: name.into(),
                icon: icon.into(),
                nickname: None,
                created_at: at,
                needs_reconfirm: false,
            },
        )
        .await?
        .map_err(|e| format_err!("seed mark {name}: {e}"))?;
    }

    // The second device joins and catches up.
    let (_s, _g, partition) = pair(acc, l, b, "second device").await?;
    wire_us(
        acc,
        (l, "founder", &l_bytes, l_ep.as_str()),
        (b, "second", &b_bytes),
        &partition,
        &relay,
    )
    .await?;
    wait_marks(acc, b, "second device caught up", |m| m.len() == 3).await?;

    // Concurrency window: the second device makes its three writes from
    // its own frontier while the founder enrols a third device.
    b.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://added.example/".into(),
            petname: "AddedOffline".into(),
            icon: "9".into(),
            nickname: None,
            created_at: 2_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("offline add: {e}"))?;
    b.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://rename.example/".into(),
            petname: "NewName".into(),
            icon: "2".into(),
            nickname: None,
            created_at: 1_100,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("offline rename: {e}"))?;
    b.call_us_mark_forget(acc, "https://forget.example/".into())
        .await?
        .map_err(|e| format_err!("offline forget: {e}"))?;

    // The guaranteed direction: the second device wrote before the third
    // device existed, so its writes were authored against a frontier that
    // cannot contain the enrollment.
    let b_devices = b.call_us_devices_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    if b_devices.iter().any(|d| d.name == "third device") {
        bail!("ordering violated: the second device saw the enrollment before authoring");
    }
    // The other direction, reported rather than asserted (see the doc
    // comment): had the founder already merged the second device's work?
    let l_before = l.call_us_marks_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    let founder_had_merged = l_before.iter().any(|m| m.petname == "AddedOffline");
    println!(
        "            at enrollment time the founder had{} already merged the second device's writes",
        if founder_had_merged { "" } else { " NOT" }
    );

    let (_s2, _g2, partition2) = pair(acc, l, c, "third device").await?;
    if partition2 != partition {
        bail!("the second enrollment moved the partition");
    }

    // Heal, and assert all three survive on BOTH the founder and the
    // device that made them.
    let converged = |m: &[UsMark]| {
        m.iter().any(|x| x.petname == "AddedOffline")
            && m.iter().any(|x| x.petname == "NewName")
            && !m.iter().any(|x| x.provenance == "https://forget.example/")
            && m.iter().any(|x| x.petname == "Keep")
    };
    let l_marks = wait_marks(acc, l, "founder converged on the concurrent writes", converged).await?;
    let b_marks = wait_marks(acc, b, "second device converged", converged).await?;
    if !same_marks(&l_marks, &b_marks) {
        bail!("replicas diverged:\n  founder {l_marks:?}\n  second  {b_marks:?}");
    }
    if l_marks.iter().any(|m| m.petname == "OldName") {
        bail!("the rename was lost: the old name is still present");
    }
    println!(
        "            add survived, rename survived, forget did NOT resurrect ({} marks)",
        l_marks.len()
    );
    println!("\nPAIRING ACT (partitioned writer) PASSED");
    Ok(())
}
