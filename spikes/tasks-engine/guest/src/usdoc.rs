//! The user-system partition (#36), implementing PAIRING.md §4.
//!
//! One automerge doc backs all four families — `profile`, `marks`,
//! `contacts`, `devices` as top-level maps — so the WIT surface can hide
//! the partitioning and the production split into per-family docs stays a
//! later engine change with zero visor impact. The doc is created by
//! `user-create`, delegated to the USER GROUP only (never to a device),
//! and sealed immediately: the founding device is the only member, and
//! every later device joins the GROUP, which CGKA-propagates.
//!
//! Two pieces of semantics live here rather than in the visor:
//!
//! - **Invariant repair.** Petname uniqueness (case-insensitive) and hue
//!   uniqueness are cross-record invariants, so a merge can break them
//!   even though every individual write was valid. Repair is
//!   deterministic — the older record wins (`created-at`, ties broken by
//!   lexicographic provenance) — which means every device computes the
//!   same outcome from the same doc state and renders it whether or not
//!   anyone writes it. Only the device whose OWN write lost writes the
//!   repair back, which is what keeps two devices from repairing each
//!   other in a loop.
//! - **Local-echo suppression.** `us-events` reports remotely-caused
//!   changes only. That falls out of the shape here: local writes update
//!   the diff baseline as they are made, so they can never appear as a
//!   later remote delta.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjId, ObjType, ReadDoc, ScalarValue, Value, ROOT};

use crate::exports::polymorph::engine_spike::driver::{
    UsDevice, UsEvent, UsMark, UsProfile,
};
use crate::{arr32, with_state, Partition};

// --- instance state ---

#[derive(Default)]
pub(crate) struct UsDoc {
    /// The CURRENT generation's partition id (a keyhive doc id).
    ///
    /// Generations exist because enrollment regenerates the doc
    /// (PAIRING.md §2): a device added after a doc was sealed never gets
    /// a readable epoch at the pinned keyhive rev, while a doc it is a
    /// member of from epoch 0 is stably readable. The `us-*` surface
    /// never exposes this id, which is what lets the generation change
    /// underneath the visor without the visor knowing.
    pub(crate) doc: Option<Vec<u8>>,
    /// The user group every device of this user belongs to.
    pub(crate) user_group: Option<Vec<u8>>,
    /// Provenances THIS instance wrote. Two rules key off it: repair
    /// writes (only the owner of a losing write persists it) and
    /// generation reconciliation (only own values are re-written).
    my_marks: HashSet<String>,
    /// Contact keys this instance wrote.
    my_contacts: HashSet<String>,
    /// Device keys this instance wrote.
    my_devices: HashSet<String>,
    /// Contact cards already handed to keyhive, so a synced contact is
    /// ingested exactly once per instance.
    ingested_contacts: HashSet<String>,
    /// Own values staged for re-writing into a newly adopted generation
    /// (authorship + `created-at` preserved).
    pending: Option<Values>,
    /// (peer, tree) pairs already subscribed, so the poll loop does not
    /// start a fresh sync every time it runs.
    subscribed: HashSet<(Vec<u8>, Vec<u8>)>,
    /// Every generation this device has held, oldest first.
    generations: Vec<Vec<u8>>,
    /// The baseline the next drain diffs against. Deliberately NOT reset
    /// when a generation is adopted: the values a device already rendered
    /// must not be re-announced just because they moved documents.
    last: Option<Snap>,
    /// The drained event queue (per instance, per PAIRING.md §4).
    events: Vec<UsEvent>,
}

fn doc_id() -> Result<Vec<u8>, String> {
    with_state(|s| s.us.doc.clone())?
        .ok_or_else(|| "no user-system partition (user-create or pair first)".to_string())
}

// --- automerge shape ---

/// The #22 framework palette is a fixed, constrained set of OKLCH hues at
/// one lightness and chroma, and `us-mark.hue` is an INDEX into it, not an
/// angle (PAIRING.md §4). Ten entries at this rev — see the demo's
/// `VISOR_HUES` (spikes/demo/host/demo.ts). Uniqueness is only
/// promisable while unused indices exist, which is why an exhausted
/// palette leaves a collision standing rather than inventing a colour
/// outside the set the framework can render legibly.
const HUE_PALETTE_LEN: u16 = 10;

/// Forward pointer to the successor generation. A MAP, not a scalar:
/// two adders enrolling concurrently would silently last-write-wins a
/// scalar, and a fork that cannot be seen is a fork that corrupts.
const SUPERSEDED: &str = "superseded-by";

const PROFILE: &str = "profile";
const MARKS: &str = "marks";
const CONTACTS: &str = "contacts";
const DEVICES: &str = "devices";

fn map_at(am: &AutoCommit, key: &str) -> Option<ObjId> {
    match am.get(ROOT, key) {
        Ok(Some((Value::Object(ObjType::Map), id))) => Some(id),
        _ => None,
    }
}

fn child_map(am: &AutoCommit, parent: &ObjId, key: &str) -> Option<ObjId> {
    match am.get(parent, key) {
        Ok(Some((Value::Object(ObjType::Map), id))) => Some(id),
        _ => None,
    }
}

fn get_str(am: &AutoCommit, obj: &ObjId, key: &str) -> Option<String> {
    match am.get(obj, key) {
        Ok(Some((Value::Scalar(s), _))) => match s.into_owned() {
            ScalarValue::Str(v) => Some(v.to_string()),
            _ => None,
        },
        _ => None,
    }
}

fn get_u64(am: &AutoCommit, obj: &ObjId, key: &str) -> Option<u64> {
    match am.get(obj, key) {
        Ok(Some((Value::Scalar(s), _))) => match s.into_owned() {
            ScalarValue::Int(v) => Some(v.max(0) as u64),
            ScalarValue::Uint(v) => Some(v),
            ScalarValue::Timestamp(v) => Some(v.max(0) as u64),
            _ => None,
        },
        _ => None,
    }
}

fn get_bool(am: &AutoCommit, obj: &ObjId, key: &str) -> bool {
    matches!(
        am.get(obj, key),
        Ok(Some((Value::Scalar(ref s), _))) if matches!(s.as_ref(), ScalarValue::Boolean(true))
    )
}

fn get_bytes(am: &AutoCommit, obj: &ObjId, key: &str) -> Option<Vec<u8>> {
    match am.get(obj, key) {
        Ok(Some((Value::Scalar(s), _))) => match s.into_owned() {
            ScalarValue::Bytes(v) => Some(v),
            _ => None,
        },
        _ => None,
    }
}

// --- raw records ---

#[derive(Clone, PartialEq)]
struct MarkRaw {
    provenance: String,
    petname: String,
    hue: u16,
    nickname: Option<String>,
    created_at: u64,
    /// The petname the user last re-confirmed under. A confirmation is
    /// scoped to the exact name it was given for: renaming into a fresh
    /// collision must ask again, so this stores the string, not a flag.
    confirmed_for: Option<String>,
}

fn read_marks(am: &AutoCommit) -> Vec<MarkRaw> {
    let Some(marks) = map_at(am, MARKS) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in am.keys(&marks) {
        let Some(m) = child_map(am, &marks, &key) else {
            continue;
        };
        out.push(MarkRaw {
            provenance: key.to_string(),
            petname: get_str(am, &m, "petname").unwrap_or_default(),
            hue: get_u64(am, &m, "hue").unwrap_or(0) as u16,
            nickname: get_str(am, &m, "nickname"),
            created_at: get_u64(am, &m, "created-at").unwrap_or(0),
            confirmed_for: get_str(am, &m, "confirmed-for"),
        });
    }
    out
}

fn read_profile(am: &AutoCommit) -> (String, u16, Option<Vec<u8>>) {
    let Some(p) = map_at(am, PROFILE) else {
        return (String::new(), 0, None);
    };
    (
        get_str(am, &p, "display-name").unwrap_or_default(),
        get_u64(am, &p, "hue").unwrap_or(0) as u16,
        get_bytes(am, &p, "icon"),
    )
}

fn read_devices(am: &AutoCommit) -> BTreeMap<String, (String, u64, bool)> {
    let mut out = BTreeMap::new();
    let Some(devices) = map_at(am, DEVICES) else {
        return out;
    };
    for key in am.keys(&devices) {
        let Some(d) = child_map(am, &devices, &key) else {
            continue;
        };
        out.insert(
            key.to_string(),
            (
                get_str(am, &d, "name").unwrap_or_default(),
                get_u64(am, &d, "enrolled-at").unwrap_or(0),
                get_bool(am, &d, "revoked"),
            ),
        );
    }
    out
}

fn read_contacts(am: &AutoCommit) -> BTreeMap<String, (Vec<u8>, String)> {
    let mut out = BTreeMap::new();
    let Some(contacts) = map_at(am, CONTACTS) else {
        return out;
    };
    for key in am.keys(&contacts) {
        let Some(c) = child_map(am, &contacts, &key) else {
            continue;
        };
        out.insert(
            key.to_string(),
            (
                get_bytes(am, &c, "card").unwrap_or_default(),
                get_str(am, &c, "petname").unwrap_or_default(),
            ),
        );
    }
    out
}

/// A whole user-system state as VALUES, independent of which document
/// holds them. Generations copy this, not history.
#[derive(Clone, Default)]
struct Values {
    profile: (String, u16, Option<Vec<u8>>),
    marks: Vec<MarkRaw>,
    contacts: BTreeMap<String, (Vec<u8>, String)>,
    devices: BTreeMap<String, (String, u64, bool)>,
}

fn read_values(am: &AutoCommit) -> Values {
    Values {
        profile: read_profile(am),
        marks: read_marks(am),
        contacts: read_contacts(am),
        devices: read_devices(am),
    }
}

/// Just this instance's own values, for re-writing into a generation
/// whose copy predates them.
fn own_values(all: &Values, mine_marks: &HashSet<String>, mine_contacts: &HashSet<String>, mine_devices: &HashSet<String>) -> Values {
    Values {
        profile: all.profile.clone(),
        marks: all
            .marks
            .iter()
            .filter(|m| mine_marks.contains(&m.provenance))
            .cloned()
            .collect(),
        contacts: all
            .contacts
            .iter()
            .filter(|(k, _)| mine_contacts.contains(*k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        devices: all
            .devices
            .iter()
            .filter(|(k, _)| mine_devices.contains(*k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    }
}

fn write_mark_fields(am: &mut AutoCommit, obj: &ObjId, m: &MarkRaw) -> Result<(), String> {
    am.put(obj, "petname", m.petname.as_str())
        .map_err(|e| format!("petname: {e}"))?;
    am.put(obj, "hue", m.hue as i64)
        .map_err(|e| format!("hue: {e}"))?;
    if let Some(n) = &m.nickname {
        am.put(obj, "nickname", n.as_str())
            .map_err(|e| format!("nickname: {e}"))?;
    }
    // `created-at` travels with the value: it is what decides conflict
    // winners, so a copy that reset it would silently re-order the whole
    // marks table on the next merge.
    am.put(obj, "created-at", m.created_at as i64)
        .map_err(|e| format!("created-at: {e}"))?;
    if let Some(c) = &m.confirmed_for {
        am.put(obj, "confirmed-for", c.as_str())
            .map_err(|e| format!("confirmed-for: {e}"))?;
    }
    Ok(())
}

/// One automerge change containing an entire user-system state: the
/// creation change of a new generation.
fn build_generation(v: &Values) -> Result<(AutoCommit, [u8; 32], Vec<u8>), String> {
    let mut am = AutoCommit::new();
    let p = am
        .put_object(ROOT, PROFILE, ObjType::Map)
        .map_err(|e| format!("profile map: {e}"))?;
    am.put(&p, "display-name", v.profile.0.as_str())
        .map_err(|e| format!("display-name: {e}"))?;
    am.put(&p, "hue", v.profile.1 as i64)
        .map_err(|e| format!("hue: {e}"))?;
    if let Some(icon) = &v.profile.2 {
        am.put(&p, "icon", icon.clone())
            .map_err(|e| format!("icon: {e}"))?;
    }
    let marks = am
        .put_object(ROOT, MARKS, ObjType::Map)
        .map_err(|e| format!("marks map: {e}"))?;
    for m in &v.marks {
        let obj = am
            .put_object(&marks, m.provenance.as_str(), ObjType::Map)
            .map_err(|e| format!("mark entry: {e}"))?;
        write_mark_fields(&mut am, &obj, m)?;
    }
    let contacts = am
        .put_object(ROOT, CONTACTS, ObjType::Map)
        .map_err(|e| format!("contacts map: {e}"))?;
    for (key, (card, petname)) in &v.contacts {
        let obj = am
            .put_object(&contacts, key.as_str(), ObjType::Map)
            .map_err(|e| format!("contact entry: {e}"))?;
        am.put(&obj, "card", card.clone())
            .map_err(|e| format!("contact card: {e}"))?;
        am.put(&obj, "petname", petname.as_str())
            .map_err(|e| format!("contact petname: {e}"))?;
    }
    let devices = am
        .put_object(ROOT, DEVICES, ObjType::Map)
        .map_err(|e| format!("devices map: {e}"))?;
    for (key, (name, enrolled_at, revoked)) in &v.devices {
        let obj = am
            .put_object(&devices, key.as_str(), ObjType::Map)
            .map_err(|e| format!("device entry: {e}"))?;
        am.put(&obj, "name", name.as_str())
            .map_err(|e| format!("device name: {e}"))?;
        am.put(&obj, "enrolled-at", *enrolled_at as i64)
            .map_err(|e| format!("enrolled-at: {e}"))?;
        am.put(&obj, "revoked", *revoked)
            .map_err(|e| format!("revoked: {e}"))?;
    }
    am.commit();
    let change = am
        .get_last_local_change()
        .ok_or("generation creation produced no change")?;
    let cref = change.hash().0;
    let chunk = change.raw_bytes().to_vec();
    Ok((am, cref, chunk))
}

/// Successor generations recorded in a doc, lexicographically ordered.
fn successors(am: &AutoCommit) -> Vec<String> {
    let Some(ptr) = map_at(am, SUPERSEDED) else {
        return Vec::new();
    };
    let mut out: Vec<String> = am.keys(&ptr).map(|k| k.to_string()).collect();
    out.sort();
    out
}

/// Create the next generation of the user-system doc and point the
/// current one at it (PAIRING.md §2).
///
/// The joiner is a member of this document from epoch 0, which is the
/// only arrangement measured to be stably readable at the pinned keyhive
/// rev. What crosses over is VALUES, not history: the read-back window
/// for user-system data is "what the account currently believes", and
/// the automerge history of how it got there is not something any device
/// renders.
async fn regenerate() -> Result<Vec<u8>, String> {
    let old_id = doc_id()?;
    let group = with_state(|s| s.us.user_group.clone())?
        .ok_or("no user group on this device")?;
    let values = read_us(read_values)?;

    let (am, cref, chunk) = build_generation(&values)?;
    let new_id = crate::create_doc_for(cref).await?;
    crate::add_doc_member(&new_id, &group, "edit").await?;
    with_state(|s| {
        let mut applied = HashSet::new();
        applied.insert(cref);
        s.partitions.insert(
            new_id.clone(),
            Partition {
                am,
                applied,
                revision: 1,
                undecryptable: 0,
                decrypted: 0,
            },
        );
    })?;
    // Create → delegate → seal, in that order: the epoch at seal time is
    // what determines readership, and this is the whole reason the
    // generation exists.
    crate::encrypt_and_commit(&new_id, chunk, vec![], cref).await?;

    // The forward pointer goes into the OLD generation, so any device
    // still reading the old one finds the way forward on its next sync.
    let pointer_key = hex::encode(&new_id);
    crate::author(&old_id, move |am| {
        let ptr = match map_at(am, SUPERSEDED) {
            Some(p) => p,
            None => am
                .put_object(ROOT, SUPERSEDED, ObjType::Map)
                .map_err(|e| format!("superseded map: {e}"))?,
        };
        am.put(&ptr, pointer_key.as_str(), true)
            .map_err(|e| format!("forward pointer: {e}"))?;
        Ok(())
    })
    .await?;

    with_state(|s| {
        s.us.doc = Some(new_id.clone());
        s.us.generations.push(new_id.clone());
    })?;
    // This device authored the copy, so none of it is news to it.
    set_baseline()?;
    Ok(new_id)
}

/// Follow a forward pointer, if the current generation carries one.
///
/// The baseline is deliberately carried across: every value that came
/// over in the copy is one this device already rendered, and #22 is
/// explicit that announcements are for remotely-caused CHANGES, not for
/// bookkeeping the user cannot perceive.
async fn follow_pointer() -> Result<Option<Vec<u8>>, String> {
    let current = doc_id()?;
    let heirs = read_us(successors)?;
    if heirs.is_empty() {
        return Ok(None);
    }
    if heirs.len() > 1 {
        // Not gated in v1: pairing is humanly serialized, so this is a
        // report-loudly path rather than a solved one (PAIRING.md §2).
        eprintln!(
            concat!(
                "[us] GENERATION FORK: {} successors recorded on {}; taking the ",
                "lexicographically smallest ({}). A losing adder must repeat ",
                "its finalization atop the winner."
            ),
            heirs.len(),
            hex::encode(&current[..4]),
            &heirs[0][..8]
        );
    }
    let winner = hex::decode(&heirs[0]).map_err(|e| format!("bad successor id: {e}"))?;
    if winner == current {
        return Ok(None);
    }

    // Stage this device's own values before switching: the copy was taken
    // on the adder, and anything this device wrote that had not reached
    // it yet would otherwise be lost with the old generation.
    let (all, mine_marks, mine_contacts, mine_devices) = {
        let all = read_us(read_values)?;
        with_state(|s| {
            (
                all,
                s.us.my_marks.clone(),
                s.us.my_contacts.clone(),
                s.us.my_devices.clone(),
            )
        })?
    };
    let mine = own_values(&all, &mine_marks, &mine_contacts, &mine_devices);

    with_state(|s| {
        s.partitions
            .entry(winner.clone())
            .or_insert_with(|| Partition {
                am: AutoCommit::new(),
                applied: HashSet::new(),
                revision: 0,
                undecryptable: 0,
                decrypted: 0,
            });
        s.us.doc = Some(winner.clone());
        s.us.generations.push(winner.clone());
        s.us.pending = Some(mine);
    })?;
    crate::flush_keyhive().await?;
    Ok(Some(winner))
}

/// Re-write this device's own values that the generation copy predates.
///
/// Only own values, and only missing ones: a device that re-wrote values
/// it merely READ would resurrect entries other devices had deleted, and
/// would do it with its own authorship.
async fn reconcile_pending() -> Result<(), String> {
    let Some(mine) = with_state(|s| s.us.pending.clone())? else {
        return Ok(());
    };
    // Wait until the new generation has actually materialized, or
    // "missing" cannot be distinguished from "not synced yet".
    if read_us(|am| map_at(am, PROFILE).is_none())? {
        return Ok(());
    }
    let current = read_us(read_values)?;
    let id = doc_id()?;

    for m in &mine.marks {
        if current.marks.iter().any(|c| c.provenance == m.provenance) {
            continue;
        }
        let m = m.clone();
        crate::author(&id, move |am| {
            let marks = match map_at(am, MARKS) {
                Some(x) => x,
                None => am
                    .put_object(ROOT, MARKS, ObjType::Map)
                    .map_err(|e| format!("marks map: {e}"))?,
            };
            let obj = am
                .put_object(&marks, m.provenance.as_str(), ObjType::Map)
                .map_err(|e| format!("mark entry: {e}"))?;
            write_mark_fields(am, &obj, &m)
        })
        .await?;
    }
    for (key, (card, petname)) in &mine.contacts {
        if current.contacts.contains_key(key) {
            continue;
        }
        let (key, card, petname) = (key.clone(), card.clone(), petname.clone());
        crate::author(&id, move |am| {
            let contacts = match map_at(am, CONTACTS) {
                Some(x) => x,
                None => am
                    .put_object(ROOT, CONTACTS, ObjType::Map)
                    .map_err(|e| format!("contacts map: {e}"))?,
            };
            let obj = am
                .put_object(&contacts, key.as_str(), ObjType::Map)
                .map_err(|e| format!("contact entry: {e}"))?;
            am.put(&obj, "card", card)
                .map_err(|e| format!("contact card: {e}"))?;
            am.put(&obj, "petname", petname.as_str())
                .map_err(|e| format!("contact petname: {e}"))?;
            Ok(())
        })
        .await?;
    }
    for (key, (name, enrolled_at, revoked)) in &mine.devices {
        if current.devices.contains_key(key) {
            continue;
        }
        let (key, name, enrolled_at, revoked) =
            (key.clone(), name.clone(), *enrolled_at, *revoked);
        crate::author(&id, move |am| {
            let devices = match map_at(am, DEVICES) {
                Some(x) => x,
                None => am
                    .put_object(ROOT, DEVICES, ObjType::Map)
                    .map_err(|e| format!("devices map: {e}"))?,
            };
            let obj = am
                .put_object(&devices, key.as_str(), ObjType::Map)
                .map_err(|e| format!("device entry: {e}"))?;
            am.put(&obj, "name", name.as_str())
                .map_err(|e| format!("device name: {e}"))?;
            am.put(&obj, "enrolled-at", enrolled_at as i64)
                .map_err(|e| format!("enrolled-at: {e}"))?;
            am.put(&obj, "revoked", revoked)
                .map_err(|e| format!("revoked: {e}"))?;
            Ok(())
        })
        .await?;
    }

    with_state(|s| s.us.pending = None)?;
    // Reconciliation is this device's own writing; it is not news.
    set_baseline()
}

/// Keep a subscription open to the CURRENT generation with every peer.
///
/// Engine-driven because the host cannot see generations: `us-*` hides
/// doc identity by design, and enrollment changes it.
fn ensure_subscriptions() -> Result<(), String> {
    let Some(tree) = with_state(|s| s.us.doc.clone())? else {
        return Ok(());
    };
    for peer in crate::known_peers()? {
        let key = (peer.clone(), tree.clone());
        if with_state(|s| s.us.subscribed.contains(&key))? {
            continue;
        }
        if crate::subscribe_tree(peer, tree.clone()).is_ok() {
            with_state(|s| s.us.subscribed.insert(key))?;
        }
    }
    Ok(())
}

// --- deterministic invariant repair (PAIRING.md §4) ---

/// The repaired rendering of the marks, plus the set of repairs it took
/// to get there. Both are pure functions of the doc state, which is what
/// makes every device agree without coordinating.
struct Repaired {
    marks: Vec<UsMark>,
    /// `(provenance, "petname" | "hue")`.
    repairs: BTreeSet<(String, String)>,
    /// The hue each mark should carry after repair, for the write-back
    /// rule (only the owner of a losing write persists it).
    hues: HashMap<String, u16>,
}

fn repair(raw: &[MarkRaw]) -> Repaired {
    // Canonical order IS the conflict rule: older `created-at` wins, ties
    // broken lexicographically by provenance. Every device sorts the same
    // way, so every device picks the same winner.
    let mut order: Vec<&MarkRaw> = raw.iter().collect();
    order.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.provenance.cmp(&b.provenance))
    });

    // Reassigned hues must dodge every hue anyone authored, not just the
    // ones assigned so far — otherwise repairing one collision could
    // manufacture the next.
    let reserved: HashSet<u16> = raw.iter().map(|m| m.hue).collect();
    let mut claimed_petnames: HashSet<String> = HashSet::new();
    let mut claimed_hues: HashSet<u16> = HashSet::new();
    let mut repairs = BTreeSet::new();
    let mut hues = HashMap::new();
    let mut marks = Vec::new();

    for m in order {
        let petname_loser = !claimed_petnames.insert(m.petname.to_lowercase());
        let needs_reconfirm = if petname_loser {
            repairs.insert((m.provenance.clone(), "petname".to_string()));
            // The loser keeps its petname bytes; what it loses is the
            // user's assumption that the name is unambiguous. The visor
            // re-introduces it, and `us-mark-confirm` clears the flag.
            m.confirmed_for.as_deref() != Some(m.petname.as_str())
        } else {
            false
        };
        let hue = if claimed_hues.contains(&m.hue) {
            // Smallest unused palette index. If the palette is exhausted
            // the collision stands: that is what assignment already does
            // when it runs out, and manufacturing an index outside the
            // palette would render as something the framework never
            // promised to keep legible or distinguishable.
            match (0..HUE_PALETTE_LEN)
                .find(|h| !reserved.contains(h) && !claimed_hues.contains(h))
            {
                Some(free) => {
                    repairs.insert((m.provenance.clone(), "hue".to_string()));
                    free
                }
                None => m.hue,
            }
        } else {
            m.hue
        };
        claimed_hues.insert(hue);
        hues.insert(m.provenance.clone(), hue);
        marks.push(UsMark {
            provenance: m.provenance.clone(),
            petname: m.petname.clone(),
            hue,
            nickname: m.nickname.clone(),
            created_at: m.created_at,
            needs_reconfirm,
        });
    }
    Repaired {
        marks,
        repairs,
        hues,
    }
}

// --- snapshots and the event diff ---

#[derive(Clone, Default, PartialEq)]
struct Snap {
    profile: (String, u16, Option<Vec<u8>>),
    /// The REPAIRED view, keyed by provenance: diffing repaired views is
    /// what keeps a repair write from announcing itself twice.
    marks: BTreeMap<String, (String, u16, Option<String>, u64, bool)>,
    repairs: BTreeSet<(String, String)>,
    devices: BTreeMap<String, (String, u64, bool)>,
}

fn snapshot(am: &AutoCommit) -> Snap {
    let repaired = repair(&read_marks(am));
    Snap {
        profile: read_profile(am),
        marks: repaired
            .marks
            .into_iter()
            .map(|m| {
                (
                    m.provenance,
                    (
                        m.petname,
                        m.hue,
                        m.nickname,
                        m.created_at,
                        m.needs_reconfirm,
                    ),
                )
            })
            .collect(),
        repairs: repaired.repairs,
        devices: read_devices(am),
    }
}

fn diff(pre: &Snap, post: &Snap) -> Vec<UsEvent> {
    let mut out = Vec::new();
    if pre.profile != post.profile {
        out.push(UsEvent::ProfileChanged);
    }
    let new_repairs: Vec<&(String, String)> =
        post.repairs.difference(&pre.repairs).collect();
    let repaired_now: HashSet<&String> = new_repairs.iter().map(|(p, _)| p).collect();
    for (prov, value) in &post.marks {
        match pre.marks.get(prov) {
            None => out.push(UsEvent::MarkAdded(prov.clone())),
            Some(before) if before != value && !repaired_now.contains(prov) => {
                out.push(UsEvent::MarkChanged(prov.clone()))
            }
            Some(_) => {}
        }
    }
    for (prov, kind) in new_repairs {
        out.push(UsEvent::MarkConflictRepaired((prov.clone(), kind.clone())));
    }
    for (id, (name, _, revoked)) in &post.devices {
        match pre.devices.get(id) {
            None => out.push(UsEvent::DeviceAdded(name.clone())),
            Some((_, _, was_revoked)) if !*was_revoked && *revoked => {
                out.push(UsEvent::DeviceRevoked(name.clone()))
            }
            Some(_) => {}
        }
    }
    out
}

// --- the pump: apply, repair, announce ---

fn read_us<R>(f: impl FnOnce(&AutoCommit) -> R) -> Result<R, String> {
    let id = doc_id()?;
    with_state(|s| {
        s.partitions
            .get(&id)
            .map(|p| f(&p.am))
            .ok_or_else(|| "user-system partition not held".to_string())
    })?
}

fn set_baseline() -> Result<(), String> {
    let snap = read_us(snapshot)?;
    with_state(|s| s.us.last = Some(snap))
}

/// Apply whatever synced, re-derive the invariants, queue the events, and
/// persist this device's own losing repair (and only its own).
pub(crate) async fn pump() -> Result<(), String> {
    if with_state(|s| s.us.doc.is_none())? {
        return Ok(());
    }
    // Apply, then follow any forward pointer, then apply the successor.
    // Bounded: a device that has been offline across several enrollments
    // walks the chain, but a malformed cycle must not spin here.
    for _ in 0..8 {
        let id = doc_id()?;
        crate::apply_new_chunks(&id).await?;
        if follow_pointer().await?.is_none() {
            break;
        }
    }
    ensure_subscriptions()?;
    reconcile_pending().await?;

    // Received cards are state that must reach every device (the G3
    // finding: the wire will not carry a foreign group's ops to
    // non-members), so contacts arriving through the doc are ingested
    // here rather than assumed present.
    let contacts = read_us(read_contacts)?;
    for (key, (card, _)) in contacts {
        if card.is_empty() {
            continue;
        }
        let fresh = with_state(|s| s.us.ingested_contacts.insert(key.clone()))?;
        if fresh {
            if let Err(e) = crate::ingest_static_card(card).await {
                eprintln!("[us] contact ingest: {e}");
            }
        }
    }

    let pre = with_state(|s| s.us.last.clone())?.unwrap_or_default();
    let post = read_us(snapshot)?;
    let events = diff(&pre, &post);
    with_state(|s| {
        s.us.last = Some(post);
        s.us.events.extend(events);
    })?;

    repair_writes().await
}

/// Persist repairs, but only the ones this device's own write caused.
/// Every device computed the same outcome; if all of them wrote it, the
/// doc would churn for no gain, so the loser's owner is the one that
/// commits it and everyone else just renders it.
async fn repair_writes() -> Result<(), String> {
    let (raw, mine) = {
        let raw = read_us(read_marks)?;
        let mine = with_state(|s| s.us.my_marks.clone())?;
        (raw, mine)
    };
    let repaired = repair(&raw);
    let mut pending: Vec<(String, u16)> = Vec::new();
    for m in &raw {
        if !mine.contains(&m.provenance) {
            continue;
        }
        if repaired
            .repairs
            .contains(&(m.provenance.clone(), "hue".to_string()))
        {
            let want = repaired.hues.get(&m.provenance).copied().unwrap_or(m.hue);
            if want != m.hue {
                pending.push((m.provenance.clone(), want));
            }
        }
    }
    if pending.is_empty() {
        return Ok(());
    }
    let id = doc_id()?;
    for (provenance, hue) in pending {
        crate::author(&id, |am| {
            let marks = map_at(am, MARKS).ok_or("no marks map")?;
            let m = child_map(am, &marks, &provenance).ok_or("mark vanished")?;
            am.put(&m, "hue", hue as i64)
                .map_err(|e| format!("repair hue: {e}"))?;
            Ok(())
        })
        .await?;
    }
    // The repair is this device's own write, so it must not come back as
    // an announcement on the next drain.
    set_baseline()
}

/// Every local write goes through here: pump first (so anything remote
/// that is already in flight is announced before the local change lands),
/// then author, then re-baseline so the local write is never echoed.
async fn write<R>(f: impl FnOnce(&mut AutoCommit) -> Result<R, String>) -> Result<R, String> {
    pump().await?;
    let id = doc_id()?;
    let out = crate::author(&id, f).await?;
    set_baseline()?;
    Ok(out)
}

// --- the driver surface ---

/// First device only: the user group, the user-system doc, the initial
/// profile. Ordering is load-bearing (create → delegate → seal): BeeKEM
/// adds are not retroactive, so the doc's first epoch must already cover
/// its intended readership.
pub(crate) async fn create(profile: UsProfile) -> Result<Vec<u8>, String> {
    if with_state(|s| s.us.doc.is_some())? {
        return Err("user-system partition already exists".into());
    }
    let group = crate::create_user_group().await?;

    let mut am = AutoCommit::new();
    let p = am
        .put_object(ROOT, PROFILE, ObjType::Map)
        .map_err(|e| format!("profile map: {e}"))?;
    am.put(&p, "display-name", profile.display_name.as_str())
        .map_err(|e| format!("display-name: {e}"))?;
    am.put(&p, "hue", profile.hue as i64)
        .map_err(|e| format!("hue: {e}"))?;
    if let Some(icon) = profile.icon.clone() {
        am.put(&p, "icon", icon).map_err(|e| format!("icon: {e}"))?;
    }
    for family in [MARKS, CONTACTS, DEVICES] {
        am.put_object(ROOT, family, ObjType::Map)
            .map_err(|e| format!("{family} map: {e}"))?;
    }
    am.commit();
    let change = am
        .get_last_local_change()
        .ok_or("user-system creation produced no change")?;
    let cref = change.hash().0;
    let chunk = change.raw_bytes().to_vec();

    let id = crate::create_doc_for(cref).await?;
    // Delegated to the user GROUP only, never to a device: membership of
    // the group is the whole access story, and pairing adds to the group.
    crate::add_doc_member(&id, &group, "edit").await?;

    with_state(|s| {
        let mut applied = HashSet::new();
        applied.insert(cref);
        s.partitions.insert(
            id.clone(),
            Partition {
                am,
                applied,
                revision: 1,
                undecryptable: 0,
                decrypted: 0,
            },
        );
        s.us.doc = Some(id.clone());
        s.us.user_group = Some(group.clone());
    })?;
    // Sealed immediately: a single founding member means there is no
    // add-before-seal window to keep open.
    crate::encrypt_and_commit(&id, chunk, vec![], cref).await?;

    // CONTRACT: §2 has the ADDER name every device it enrolls, but §3
    // gives `user-create` no name for the founding device. Recording it
    // with an empty name keeps `us-devices-list` complete (a missing
    // first device would be worse than an unnamed one) and leaves the
    // naming to the visor. Flagged to the dispatcher.
    device_entry(&crate::own_agent_id()?, "").await?;
    set_baseline()?;
    Ok(group)
}

/// Adopt an existing user-system partition (the joiner's step 7).
pub(crate) async fn adopt(partition_id: &[u8], user_group_id: &[u8]) -> Result<(), String> {
    with_state(|s| {
        s.partitions
            .entry(partition_id.to_vec())
            .or_insert_with(|| Partition {
                am: AutoCommit::new(),
                applied: HashSet::new(),
                revision: 0,
                undecryptable: 0,
                decrypted: 0,
            });
        s.us.doc = Some(partition_id.to_vec());
        s.us.user_group = Some(user_group_id.to_vec());
        // No baseline: the profile, marks and devices this device is
        // about to learn ARE remotely-caused changes, and #22 says they
        // are announced, never silently adopted.
        s.us.last = None;
    })?;
    crate::flush_keyhive().await
}

/// The adder's enrollment writes, in the order PAIRING.md §2 pins.
pub(crate) async fn enroll_device(
    joiner: &[u8],
    name: &str,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), String> {
    let group = with_state(|s| s.us.user_group.clone())?
        .ok_or("no user group on this device (user-create first)")?;
    // 1. Admin membership FIRST. Enrollment is the consequential grant —
    // a device of the user is admin of everything the user reaches — and
    // it must exist before the card is exported, or the card the joiner
    // ingests will not carry the delegation that makes it a member.
    crate::add_to_group(&group, joiner, "admin").await?;
    // 2. A forced fresh epoch on every doc delegated to the user group,
    // per PAIRING.md §2.
    //
    // Measured, and NOT load-bearing for readability: with this switched
    // off (and with the ENROLL card suppressed too) a device added after
    // the doc was sealed still reads content written afterwards, because
    // keyhive's own `add_member` already propagates the CGKA add to every
    // doc that transitively contains the group, and the next encryption
    // derives from it. It is kept as defence in depth — a deliberate
    // epoch boundary at the moment a device joins is a property worth
    // having independently of whether readability needs it.
    //
    // `PM_NO_ROTATE` exists to keep that measurement re-runnable rather
    // than a claim in a comment.
    if std::env::var("PM_NO_ROTATE").is_err() {
        crate::rotate_docs_for_group(&group).await?;
    }
    // 3. Regenerate the user-system doc: the STATE-HANDOFF mechanism
    // (PAIRING.md §2).
    //
    // Not a workaround for a readability defect — that diagnosis was
    // wrong (see the README finding). A late joiner decrypts post-join
    // chunks fine; what it cannot do is MATERIALIZE them, because their
    // automerge dependency chain roots in changes written before it
    // joined, and automerge buffers changes whose deps are missing.
    // Causal read-back would need the Envelope content format (#36), so
    // until then the generation is what hands a new device the account's
    // current state.
    //
    // The env switch exists for one gate only: the harness act that
    // exercises a post-seal add on the ORIGINAL doc, which is how the
    // event-delivery fix is verified directly rather than through the
    // handoff that would mask it.
    let partition = if std::env::var("PM_NO_REGEN").is_ok() {
        doc_id()?
    } else {
        regenerate().await?
    };
    // 4. The card, exported for the new INDIVIDUAL (the G3 finding: an
    // individual's card carries every membership the person can reach;
    // a group's card carries the memberships the GROUP reaches, which
    // excludes its own constitutive ops).
    let card = crate::export_static_card(joiner).await?;
    // 5. The devices entry — written to the NEW generation — then flush.
    device_entry(joiner, name).await?;
    crate::flush_keyhive().await?;
    Ok((group, card, partition))
}

async fn device_entry(agent: &[u8], name: &str) -> Result<(), String> {
    let key = hex::encode(agent);
    with_state(|s| s.us.my_devices.insert(key.clone()))?;
    let enrolled_at = crate::now_ms_u64();
    let name = name.to_string();
    write(move |am| {
        let devices = match map_at(am, DEVICES) {
            Some(d) => d,
            None => am
                .put_object(ROOT, DEVICES, ObjType::Map)
                .map_err(|e| format!("devices map: {e}"))?,
        };
        let d = match child_map(am, &devices, &key) {
            Some(d) => d,
            None => am
                .put_object(&devices, &key, ObjType::Map)
                .map_err(|e| format!("device entry: {e}"))?,
        };
        am.put(&d, "name", name.as_str())
            .map_err(|e| format!("device name: {e}"))?;
        am.put(&d, "enrolled-at", enrolled_at as i64)
            .map_err(|e| format!("enrolled-at: {e}"))?;
        am.put(&d, "revoked", false)
            .map_err(|e| format!("revoked: {e}"))?;
        Ok(())
    })
    .await
}

pub(crate) async fn profile_get() -> Result<UsProfile, String> {
    pump().await?;
    let (display_name, hue, icon) = read_us(read_profile)?;
    Ok(UsProfile {
        display_name,
        hue,
        icon,
    })
}

pub(crate) async fn profile_set(profile: UsProfile) -> Result<(), String> {
    write(move |am| {
        let p = match map_at(am, PROFILE) {
            Some(p) => p,
            None => am
                .put_object(ROOT, PROFILE, ObjType::Map)
                .map_err(|e| format!("profile map: {e}"))?,
        };
        am.put(&p, "display-name", profile.display_name.as_str())
            .map_err(|e| format!("display-name: {e}"))?;
        am.put(&p, "hue", profile.hue as i64)
            .map_err(|e| format!("hue: {e}"))?;
        match profile.icon {
            Some(icon) => am.put(&p, "icon", icon).map_err(|e| format!("icon: {e}"))?,
            None => {
                let _ = am.delete(&p, "icon");
            }
        }
        Ok(())
    })
    .await
}

pub(crate) async fn marks_list() -> Result<Vec<UsMark>, String> {
    pump().await?;
    let raw = read_us(read_marks)?;
    Ok(repair(&raw).marks)
}

pub(crate) async fn mark_put(mark: UsMark) -> Result<(), String> {
    let provenance = mark.provenance.clone();
    if provenance.is_empty() {
        return Err("a mark needs a provenance".into());
    }
    with_state(|s| s.us.my_marks.insert(provenance.clone()))?;
    write(move |am| {
        let marks = match map_at(am, MARKS) {
            Some(m) => m,
            None => am
                .put_object(ROOT, MARKS, ObjType::Map)
                .map_err(|e| format!("marks map: {e}"))?,
        };
        let existing = child_map(am, &marks, &provenance);
        let m = match existing.clone() {
            Some(m) => m,
            None => am
                .put_object(&marks, &provenance, ObjType::Map)
                .map_err(|e| format!("mark entry: {e}"))?,
        };
        am.put(&m, "petname", mark.petname.as_str())
            .map_err(|e| format!("petname: {e}"))?;
        am.put(&m, "hue", mark.hue as i64)
            .map_err(|e| format!("hue: {e}"))?;
        match mark.nickname {
            Some(n) => am
                .put(&m, "nickname", n.as_str())
                .map_err(|e| format!("nickname: {e}"))?,
            None => {
                let _ = am.delete(&m, "nickname");
            }
        }
        am.put(&m, "created-at", mark.created_at as i64)
            .map_err(|e| format!("created-at: {e}"))?;
        // `needs-reconfirm` is DERIVED, not stored: it is a property of
        // the collision, which every device recomputes identically. A
        // caller round-tripping a mark therefore cannot pin the flag on
        // (or off) by accident.
        Ok(())
    })
    .await
}

pub(crate) async fn mark_forget(provenance: String) -> Result<(), String> {
    with_state(|s| s.us.my_marks.remove(&provenance))?;
    write(move |am| {
        let marks = map_at(am, MARKS).ok_or("no marks map")?;
        am.delete(&marks, provenance.as_str())
            .map_err(|e| format!("forget mark: {e}"))?;
        Ok(())
    })
    .await
}

pub(crate) async fn mark_confirm(provenance: String) -> Result<(), String> {
    write(move |am| {
        let marks = map_at(am, MARKS).ok_or("no marks map")?;
        let m = child_map(am, &marks, &provenance).ok_or("unknown mark")?;
        let petname = get_str(am, &m, "petname").unwrap_or_default();
        // Scoped to the exact name confirmed: a later rename into a new
        // collision asks again rather than inheriting this answer.
        am.put(&m, "confirmed-for", petname.as_str())
            .map_err(|e| format!("confirm mark: {e}"))?;
        Ok(())
    })
    .await
}

pub(crate) async fn contacts_list() -> Result<Vec<(Vec<u8>, String)>, String> {
    pump().await?;
    Ok(read_us(read_contacts)?.into_values().collect())
}

pub(crate) async fn contact_put(card: Vec<u8>, petname: String) -> Result<(), String> {
    // Keyed by a digest of the card so the same card put twice is one
    // entry on every device, with no id parsing on the write path.
    let key = hex::encode(&blake3::hash(&card).as_bytes()[..16]);
    crate::ingest_static_card(card.clone()).await?;
    with_state(|s| {
        s.us.ingested_contacts.insert(key.clone());
        s.us.my_contacts.insert(key.clone());
    })?;
    write(move |am| {
        let contacts = match map_at(am, CONTACTS) {
            Some(c) => c,
            None => am
                .put_object(ROOT, CONTACTS, ObjType::Map)
                .map_err(|e| format!("contacts map: {e}"))?,
        };
        let c = match child_map(am, &contacts, &key) {
            Some(c) => c,
            None => am
                .put_object(&contacts, &key, ObjType::Map)
                .map_err(|e| format!("contact entry: {e}"))?,
        };
        am.put(&c, "card", card)
            .map_err(|e| format!("contact card: {e}"))?;
        am.put(&c, "petname", petname.as_str())
            .map_err(|e| format!("contact petname: {e}"))?;
        Ok(())
    })
    .await
}

pub(crate) async fn devices_list() -> Result<Vec<UsDevice>, String> {
    pump().await?;
    let devices = read_us(read_devices)?;
    let mut out = Vec::new();
    for (key, (name, enrolled_at, revoked)) in devices {
        let Ok(raw) = hex::decode(&key) else { continue };
        out.push(UsDevice {
            agent_id: raw,
            name,
            enrolled_at,
            revoked,
        });
    }
    out.sort_by(|a, b| {
        a.enrolled_at
            .cmp(&b.enrolled_at)
            .then_with(|| a.agent_id.cmp(&b.agent_id))
    });
    Ok(out)
}

pub(crate) async fn device_revoke(agent_id: Vec<u8>) -> Result<(), String> {
    let _ = arr32(&agent_id, "agent id")?;
    let group = with_state(|s| s.us.user_group.clone())?
        .ok_or("no user group on this device")?;
    // The membership revocation is the real one: docs containing the
    // group drop CGKA leaves for individuals no longer reachable. The
    // doc entry below is the annotation the visor renders.
    crate::revoke_from_group(&group, &agent_id).await?;
    let key = hex::encode(&agent_id);
    write(move |am| {
        let devices = map_at(am, DEVICES).ok_or("no devices map")?;
        let d = child_map(am, &devices, &key).ok_or("unknown device")?;
        am.put(&d, "revoked", true)
            .map_err(|e| format!("revoke device: {e}"))?;
        Ok(())
    })
    .await
}

pub(crate) async fn events() -> Result<Vec<UsEvent>, String> {
    pump().await?;
    with_state(|s| std::mem::take(&mut s.us.events))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(provenance: &str, petname: &str, hue: u16, created_at: u64) -> MarkRaw {
        MarkRaw {
            provenance: provenance.into(),
            petname: petname.into(),
            hue,
            nickname: None,
            created_at,
            confirmed_for: None,
        }
    }

    #[test]
    fn older_petname_wins_and_the_loser_is_flagged() {
        let raw = vec![mark("b", "Ada", 10, 200), mark("a", "ada", 20, 100)];
        let r = repair(&raw);
        let flagged: Vec<&UsMark> = r.marks.iter().filter(|m| m.needs_reconfirm).collect();
        assert_eq!(flagged.len(), 1);
        assert_eq!(flagged[0].provenance, "b");
        assert!(r.repairs.contains(&("b".into(), "petname".into())));
    }

    #[test]
    fn equal_timestamps_break_ties_lexicographically() {
        let raw = vec![mark("z", "Ada", 10, 100), mark("a", "ada", 20, 100)];
        let r = repair(&raw);
        assert!(r.repairs.contains(&("z".into(), "petname".into())));
    }

    #[test]
    fn hue_loser_is_reassigned_to_a_hue_nobody_holds() {
        let raw = vec![
            mark("a", "one", 0, 100),
            mark("b", "two", 0, 200),
            mark("c", "three", 1, 300),
        ];
        let r = repair(&raw);
        let hues: Vec<u16> = r.marks.iter().map(|m| m.hue).collect();
        let unique: HashSet<u16> = hues.iter().copied().collect();
        assert_eq!(hues.len(), unique.len(), "hues must be unique after repair");
        assert_eq!(r.hues["b"], 2);
        assert!(r.repairs.contains(&("b".into(), "hue".into())));
    }

    #[test]
    fn an_exhausted_palette_leaves_the_collision_standing() {
        // Every index taken, then one more record colliding on hue 0:
        // there is nothing free to move it to, so it keeps its index and
        // no hue repair is claimed.
        let mut raw: Vec<MarkRaw> = (0..HUE_PALETTE_LEN)
            .map(|h| mark(&format!("p{h}"), &format!("name{h}"), h, 100 + h as u64))
            .collect();
        raw.push(mark("zz", "extra", 0, 9_000));
        let r = repair(&raw);
        assert!(!r.repairs.contains(&("zz".into(), "hue".into())));
        assert_eq!(r.hues["zz"], 0);
    }

    #[test]
    fn repair_is_order_independent() {
        let a = vec![mark("a", "same", 5, 100), mark("b", "same", 5, 200)];
        let b = vec![mark("b", "same", 5, 200), mark("a", "same", 5, 100)];
        let ra = repair(&a);
        let rb = repair(&b);
        assert_eq!(ra.repairs, rb.repairs);
        assert_eq!(ra.hues, rb.hues);
    }

    #[test]
    fn confirming_the_exact_name_clears_the_flag() {
        let mut raw = vec![mark("a", "same", 1, 100), mark("b", "same", 2, 200)];
        raw[1].confirmed_for = Some("same".into());
        let r = repair(&raw);
        assert!(r.marks.iter().all(|m| !m.needs_reconfirm));
        // The collision is still recorded, so a NEW collision later is
        // still edge-detectable.
        assert!(r.repairs.contains(&("b".into(), "petname".into())));
    }
}
