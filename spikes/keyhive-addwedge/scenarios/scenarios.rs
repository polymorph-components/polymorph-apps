//! Defensive-correctness harness: **verify that a legitimately added group
//! member can read content written after it joined.**
//!
//! Pure `keyhive_core`, in-process, native. No subduction, no iroh, no
//! wasm, no automerge — two or three Keyhive instances exchanging
//! `StaticEvent`s over a dumb in-memory channel (the pattern the
//! `spikes/keyhive` spike established). The point is to attribute the
//! readability defect observed in `spikes/tasks-engine` either to keyhive
//! itself or to our embedding, by removing everything that is ours.
//!
//! All identities here are freshly generated, obviously-synthetic test
//! identities (`MemorySigner::generate` over `OsRng`); nothing in this
//! file is or resembles real key material, and no key material is printed.
//!
//! Shared by the two runner crates (`pinned/`, `main/`) via `#[path]`, so
//! that both keyhive revisions execute *byte-identical* scenario code.

use std::sync::Arc;

use futures::lock::Mutex;
use rand::rngs::OsRng;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use beekem::encrypted::EncryptedContent;
use keyhive_core::access::Access;
use keyhive_core::event::static_event::StaticEvent;
use keyhive_core::keyhive::Keyhive;
use keyhive_core::listener::no_listener::NoListener;
use keyhive_core::principal::agent::Agent;
use keyhive_core::principal::document::id::DocumentId;
use keyhive_core::principal::group::id::GroupId;
use keyhive_core::principal::identifier::Identifier;
use keyhive_core::principal::individual::id::IndividualId;
use keyhive_core::principal::individual::op::KeyOp;
use keyhive_core::principal::individual::Individual;
use keyhive_core::principal::membered::Membered;
use keyhive_core::store::ciphertext::memory::MemoryCiphertextStore;
use keyhive_crypto::signer::memory::MemorySigner;

use future_form::Sendable;

pub type T = [u8; 32];
pub type P = Vec<u8>;
pub type CtStore = Arc<Mutex<MemoryCiphertextStore<T, P>>>;
pub type Kh = Keyhive<Sendable, MemorySigner, T, P, CtStore, NoListener, OsRng>;

type R<X> = Result<X, String>;

// ---------------------------------------------------------------------------
// instances and the dumb channel
// ---------------------------------------------------------------------------

/// One in-process keyhive instance with a synthetic in-memory identity.
pub struct Node {
    pub kh: Kh,
}

impl Node {
    pub async fn new(_name: &'static str) -> R<Node> {
        let signer = MemorySigner::generate(&mut OsRng);
        let store: CtStore = Arc::new(Mutex::new(MemoryCiphertextStore::new()));
        let kh = Keyhive::generate(signer, store, NoListener, OsRng)
            .await
            .map_err(|e| format!("keyhive generate: {e:?}"))?;
        Ok(Node { kh })
    }
}

/// How the receiving side of an add is *materialized* on the adder.
///
/// The tasks-engine uses contact cards over the wire (G3); the keyhive
/// spike's own tests use direct prekey registration. Scenario (d) exists
/// to see whether the defect keys on the card path (i.e. on pending
/// foreign-group delegations) or is independent of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Materialize {
    /// `contact_card()` / `receive_contact_card()` — the engine's path.
    Card,
    /// `expand_prekeys()` + `register_individual()` — the upstream-test path.
    Direct,
}

/// Teach `observer` about `subject`'s individual, so that `observer` can
/// resolve it as an `Agent` and compute an event set for it.
async fn learn(observer: &Node, subject: &Node, how: Materialize) -> R<IndividualId> {
    match how {
        Materialize::Card => {
            let card = subject
                .kh
                .contact_card()
                .await
                .map_err(|e| format!("contact_card: {e:?}"))?;
            observer
                .kh
                .receive_contact_card(&card)
                .await
                .map_err(|e| format!("receive_contact_card: {e:?}"))?;
            Ok(card.id())
        }
        Materialize::Direct => {
            let add_op = subject
                .kh
                .expand_prekeys()
                .await
                .map_err(|e| format!("expand_prekeys: {e:?}"))?;
            let indie = Arc::new(Mutex::new(Individual::new(KeyOp::Add(add_op))));
            let id = { indie.lock().await.id() };
            observer.kh.register_individual(indie).await;
            Ok(id)
        }
    }
}

async fn agent_for(kh: &Kh, id: Identifier) -> R<Agent<Sendable, MemorySigner, T, NoListener>> {
    kh.get_agent(id)
        .await
        .ok_or_else(|| format!("agent {id:?} not resolvable"))
}

/// Everything `from` would offer `to`, as a shuffled `StaticEvent` vector.
///
/// This is the "dumb channel": no sync protocol, no filtering beyond
/// keyhive's own `static_events_for_agent` reachability, and deliberately
/// *adversarially generous* — the full set every round.
async fn events_from(from: &Node, to_id: IndividualId, rng: &mut ChaCha8Rng) -> R<Vec<StaticEvent<T>>> {
    let agent = agent_for(&from.kh, to_id.into()).await?;
    let mut events: Vec<StaticEvent<T>> = from
        .kh
        .static_events_for_agent(&agent)
        .await
        .into_values()
        .collect();
    events.shuffle(rng);
    Ok(events)
}

/// Deliver `events` into `to`, in a randomized number of randomly-sized
/// batches. Delivery order is the independent variable of this harness:
/// the tasks-engine finding was op-arrival-order dependent (~1/3), so the
/// repro must vary it rather than fix it.
async fn ingest(to: &Node, mut events: Vec<StaticEvent<T>>, rng: &mut ChaCha8Rng) -> usize {
    if events.is_empty() {
        return 0;
    }
    let batches = rng.gen_range(1..=3usize);
    let mut stuck = 0usize;
    let per = events.len().div_ceil(batches);
    while !events.is_empty() {
        let take = per.min(events.len());
        let batch: Vec<_> = events.drain(..take).collect();
        stuck = to.kh.ingest_unsorted_static_events(batch).await.len();
    }
    stuck
}

/// One full both-ways op exchange, with the direction order randomized.
async fn exchange(a: &Node, a_id: IndividualId, b: &Node, b_id: IndividualId, rng: &mut ChaCha8Rng) -> R<usize> {
    let a_first = rng.gen_bool(0.5);
    let mut stuck = 0;
    if a_first {
        let ev = events_from(a, b_id, rng).await?;
        stuck += ingest(b, ev, rng).await;
        let ev = events_from(b, a_id, rng).await?;
        stuck += ingest(a, ev, rng).await;
    } else {
        let ev = events_from(b, a_id, rng).await?;
        stuck += ingest(a, ev, rng).await;
        let ev = events_from(a, b_id, rng).await?;
        stuck += ingest(b, ev, rng).await;
    }
    Ok(stuck)
}

// ---------------------------------------------------------------------------
// building blocks mirroring the engine's add path
// ---------------------------------------------------------------------------

fn cref(tag: &str) -> T {
    blake3::hash(tag.as_bytes()).into()
}

/// Founder creates a user group (itself admin) and a doc delegated to that
/// group at `Write` — the engine's arrangement (`spikes/tasks-engine/guest/
/// src/lib.rs:2348` `create_user_group`, `:2401` `add_doc_member`).
async fn group_and_doc(founder: &Node) -> R<(GroupId, DocumentId)> {
    let group = founder
        .kh
        .generate_group(vec![])
        .await
        .map_err(|e| format!("generate_group: {e:?}"))?;
    let gid = { group.lock().await.group_id() };

    let doc = founder
        .kh
        .generate_doc(vec![], nonempty::nonempty![cref("genesis")])
        .await
        .map_err(|e| format!("generate_doc: {e:?}"))?;
    let did = { doc.lock().await.doc_id() };

    let group_agent = agent_for(&founder.kh, gid.into()).await?;
    founder
        .kh
        .add_member(group_agent, &Membered::Document(did, doc), Access::Edit, &[])
        .await
        .map_err(|e| format!("delegate group to doc: {e:?}"))?;
    Ok((gid, did))
}

/// Add `member` to the group at admin — `kh_add_to_group` in the engine.
async fn add_to_group(founder: &Node, gid: GroupId, member: IndividualId) -> R<()> {
    let group = founder
        .kh
        .get_group(gid)
        .await
        .ok_or("group missing on founder")?;
    let agent = agent_for(&founder.kh, member.into()).await?;
    founder
        .kh
        .add_member(agent, &Membered::Group(gid, group), Access::Admin, &[])
        .await
        .map_err(|e| format!("add_to_group: {e:?}"))?;
    Ok(())
}

/// The engine's post-add forced rotation (`rotate_docs_for_group`).
async fn force_rotate(node: &Node, did: DocumentId) -> R<()> {
    let doc = node.kh.get_document(did).await.ok_or("doc missing")?;
    node.kh
        .force_pcs_update(doc)
        .await
        .map_err(|e| format!("force_pcs_update: {e:?}"))?;
    Ok(())
}

/// Seal/encrypt one chunk, returning the envelope. The CGKA update op the
/// encryption may produce rides the normal event set on the next exchange
/// (it is registered in the instance's own op log), so nothing is smuggled.
async fn encrypt(node: &Node, did: DocumentId, tag: &str, body: &str) -> R<EncryptedContent<P, T>> {
    let doc = node.kh.get_document(did).await.ok_or("doc missing")?;
    let r = cref(tag);
    let out = node
        .kh
        .try_encrypt_content(doc, &r, &vec![], body.as_bytes())
        .await
        .map_err(|e| format!("try_encrypt_content: {e:?}"))?;
    Ok(out.encrypted_content().clone())
}

async fn decrypt(node: &Node, did: DocumentId, ct: &EncryptedContent<P, T>) -> R<Vec<u8>> {
    let doc = node
        .kh
        .get_document(did)
        .await
        .ok_or("doc not known to reader")?;
    node.kh
        .try_decrypt_content(doc, ct)
        .await
        .map_err(|e| format!("{e:?}"))
}

// ---------------------------------------------------------------------------
// outcomes
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum Outcome {
    /// The property under test held.
    Pass,
    /// The property under test did not hold; the string is the decrypt error
    /// (or the setup failure that prevented the attempt).
    Fail(String),
}

impl Outcome {
    fn is_pass(&self) -> bool {
        matches!(self, Outcome::Pass)
    }
    fn detail(&self) -> String {
        match self {
            Outcome::Pass => "ok".into(),
            Outcome::Fail(e) => e.clone(),
        }
    }
}

fn check(got: R<Vec<u8>>, want: &str) -> Outcome {
    match got {
        Ok(bytes) if bytes == want.as_bytes() => Outcome::Pass,
        Ok(_) => Outcome::Fail("decrypted to the wrong plaintext".into()),
        Err(e) => Outcome::Fail(e),
    }
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

/// (a) CORE — added-after-seal member reads a post-add, post-rotation chunk.
///
/// Pre-add chunks are expected to be unreadable (BeeKEM adds are not
/// retroactive, by design); only the post-rotation chunk is asserted, and
/// the pre-add attempt is recorded separately as context.
pub async fn scenario_core(seed: u64, how: Materialize) -> (Outcome, String) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let r = async {
        let founder = Node::new("founder").await?;
        let joiner = Node::new("joiner").await?;
        let joiner_id = learn(&founder, &joiner, how).await?;
        let founder_id = learn(&joiner, &founder, how).await?;

        let (gid, did) = group_and_doc(&founder).await?;

        // SEAL: first content encryption happens before the joiner exists
        // in the group. This is the arrangement under investigation.
        let pre = encrypt(&founder, did, "chunk-pre", "before the add").await?;

        add_to_group(&founder, gid, joiner_id).await?;
        force_rotate(&founder, did).await?;

        let post = encrypt(&founder, did, "chunk-post", "after the add").await?;

        // Adversarially generous delivery: several full exchanges, so no
        // result here can be blamed on a one-shot sync missing an op.
        let mut stuck = 0;
        for _ in 0..3 {
            stuck = exchange(&founder, founder_id, &joiner, joiner_id, &mut rng).await?;
        }

        let pre_res = decrypt(&joiner, did, &pre).await;
        let post_res = decrypt(&joiner, did, &post).await;
        let note = format!(
            "stuck-events={stuck}; pre-add chunk (expected unreadable): {}",
            match &pre_res {
                Ok(_) => "READABLE".to_string(),
                Err(e) => e.clone(),
            }
        );
        Ok::<_, String>((check(post_res, "after the add"), note))
    }
    .await;
    match r {
        Ok(x) => x,
        Err(e) => (Outcome::Fail(format!("setup: {e}")), String::new()),
    }
}

/// (a2) CORE, INCREMENTAL DELIVERY — the same property, but with an op
/// exchange after *every* step.
///
/// Fidelity note: the engine calls `refreshed_sync` inside
/// `create_user_group`, `add_to_group` and `rotate_docs_for_group`
/// (`spikes/tasks-engine/guest/src/lib.rs:2353,2371,2443`), so in the
/// engine the joiner sees the group-creation and add ops *before* the
/// rotation op exists. Scenario (a) batches delivery at the end; this one
/// interleaves it, which is the arrival order the engine actually produces.
pub async fn scenario_core_incremental(seed: u64, how: Materialize) -> (Outcome, String) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let r = async {
        let founder = Node::new("founder").await?;
        let joiner = Node::new("joiner").await?;
        let joiner_id = learn(&founder, &joiner, how).await?;
        let founder_id = learn(&joiner, &founder, how).await?;

        macro_rules! sync {
            () => {
                exchange(&founder, founder_id, &joiner, joiner_id, &mut rng).await?
            };
        }

        let (gid, did) = group_and_doc(&founder).await?;
        sync!();
        let pre = encrypt(&founder, did, "chunk-pre", "before the add").await?;
        sync!();
        add_to_group(&founder, gid, joiner_id).await?;
        sync!();
        force_rotate(&founder, did).await?;
        sync!();
        let post = encrypt(&founder, did, "chunk-post", "after the add").await?;
        let mut stuck = 0;
        for _ in 0..3 {
            stuck = sync!();
        }

        let pre_res = decrypt(&joiner, did, &pre).await;
        let note = format!(
            "stuck-events={stuck}; pre-add chunk (expected unreadable): {}",
            match &pre_res {
                Ok(_) => "READABLE".to_string(),
                Err(e) => e.clone(),
            }
        );
        let post_res = decrypt(&joiner, did, &post).await;
        Ok::<_, String>((check(post_res, "after the add"), note))
    }
    .await;
    match r {
        Ok(x) => x,
        Err(e) => (Outcome::Fail(format!("setup: {e}")), String::new()),
    }
}

/// (b) CONTROL — member added *before* the doc's first seal. Expected 10/10.
pub async fn scenario_control(seed: u64, how: Materialize) -> (Outcome, String) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let r = async {
        let founder = Node::new("founder").await?;
        let joiner = Node::new("joiner").await?;
        let joiner_id = learn(&founder, &joiner, how).await?;
        let founder_id = learn(&joiner, &founder, how).await?;

        let (gid, did) = group_and_doc(&founder).await?;
        add_to_group(&founder, gid, joiner_id).await?;

        // First seal happens only now — the joiner is a member from epoch 0.
        let post = encrypt(&founder, did, "chunk-control", "member from epoch zero").await?;

        let mut stuck = 0;
        for _ in 0..3 {
            stuck = exchange(&founder, founder_id, &joiner, joiner_id, &mut rng).await?;
        }
        let res = decrypt(&joiner, did, &post).await;
        Ok::<_, String>((check(res, "member from epoch zero"), format!("stuck-events={stuck}")))
    }
    .await;
    match r {
        Ok(x) => x,
        Err(e) => (Outcome::Fail(format!("setup: {e}")), String::new()),
    }
}

/// (c) DIRECTION — the added-after-seal member encrypts; the founder reads.
///
/// The tasks-engine finding was directional (the joiner could author, the
/// founder's writes stayed dark to it), and the earlier G3 wedge was
/// intermittent in this direction, so this is measured separately.
pub async fn scenario_direction(seed: u64, how: Materialize) -> (Outcome, String) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let r = async {
        let founder = Node::new("founder").await?;
        let joiner = Node::new("joiner").await?;
        let joiner_id = learn(&founder, &joiner, how).await?;
        let founder_id = learn(&joiner, &founder, how).await?;

        let (gid, did) = group_and_doc(&founder).await?;
        let _sealed = encrypt(&founder, did, "chunk-pre", "before the add").await?;
        add_to_group(&founder, gid, joiner_id).await?;
        force_rotate(&founder, did).await?;

        for _ in 0..3 {
            exchange(&founder, founder_id, &joiner, joiner_id, &mut rng).await?;
        }

        // Now the *joiner* authors.
        let mine = encrypt(&joiner, did, "chunk-joiner", "written by the joiner").await?;
        let mut stuck = 0;
        for _ in 0..3 {
            stuck = exchange(&founder, founder_id, &joiner, joiner_id, &mut rng).await?;
        }
        let res = decrypt(&founder, did, &mine).await;
        Ok::<_, String>((check(res, "written by the joiner"), format!("stuck-events={stuck}")))
    }
    .await;
    match r {
        Ok(x) => x,
        Err(e) => (Outcome::Fail(format!("setup: {e}")), String::new()),
    }
}

/// (d) THIRD PARTY — the G3-shaped variant: a third instance holds a
/// delegation to a group whose constitutive ops it has not received, i.e.
/// a *pending foreign-group delegation*, while the core add is performed.
///
/// This probes the open question recorded in NOTES.md §Provisional plan
/// (G3): whether a pending delegation wedges epoch derivation.
pub async fn scenario_pending_delegation(seed: u64, how: Materialize) -> (Outcome, String) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let r = async {
        let founder = Node::new("founder").await?;
        let joiner = Node::new("joiner").await?;
        let stranger = Node::new("stranger").await?;

        let joiner_id = learn(&founder, &joiner, how).await?;
        let founder_id = learn(&joiner, &founder, how).await?;
        let stranger_id = learn(&founder, &stranger, how).await?;
        let _ = learn(&stranger, &founder, how).await?;

        // Stranger owns a group of its own; the founder delegates the doc
        // to it WITHOUT the joiner ever receiving that group's own ops —
        // exactly the "card not distributed to every member instance"
        // shape from the G3 finding.
        let stranger_group = stranger
            .kh
            .generate_group(vec![])
            .await
            .map_err(|e| format!("generate_group (stranger): {e:?}"))?;
        let sgid = { stranger_group.lock().await.group_id() };
        // Founder learns the stranger's group only (its constitutive ops),
        // by a one-way delivery from stranger to founder.
        let ev = events_from(&stranger, stranger_id, &mut rng).await?;
        ingest(&founder, ev, &mut rng).await;

        let (gid, did) = group_and_doc(&founder).await?;
        if let Some(agent) = founder.kh.get_agent(sgid.into()).await {
            let doc = founder.kh.get_document(did).await.ok_or("doc missing")?;
            founder
                .kh
                .add_member(agent, &Membered::Document(did, doc), Access::Edit, &[])
                .await
                .map_err(|e| format!("delegate stranger group to doc: {e:?}"))?;
        }

        let _sealed = encrypt(&founder, did, "chunk-pre", "before the add").await?;
        add_to_group(&founder, gid, joiner_id).await?;
        force_rotate(&founder, did).await?;
        let post = encrypt(&founder, did, "chunk-post", "after the add").await?;

        // Joiner talks ONLY to the founder — it never learns the stranger's
        // group, so it holds a delegation whose delegate never materializes.
        let mut stuck = 0;
        for _ in 0..3 {
            stuck = exchange(&founder, founder_id, &joiner, joiner_id, &mut rng).await?;
        }
        let res = decrypt(&joiner, did, &post).await;
        Ok::<_, String>((check(res, "after the add"), format!("stuck-events={stuck}")))
    }
    .await;
    match r {
        Ok(x) => x,
        Err(e) => (Outcome::Fail(format!("setup: {e}")), String::new()),
    }
}

/// (e) MULTI-DEVICE — an existing second member authors before the add, so
/// the epoch current at add time was minted by a device *other than the
/// adder*. This is the engine's real topology (laptop + phone both in the
/// user group; the tablet/new device enrolled later), and it is the shape
/// in which "the adder grafts a leaf onto a tree whose current epoch it did
/// not create" can be distinguished from the simple two-party case.
pub async fn scenario_multidevice(seed: u64, how: Materialize) -> (Outcome, String) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let r = async {
        let founder = Node::new("founder").await?;
        let phone = Node::new("phone").await?;
        let joiner = Node::new("joiner").await?;

        let phone_id = learn(&founder, &phone, how).await?;
        let founder_id = learn(&phone, &founder, how).await?;
        let joiner_id = learn(&founder, &joiner, how).await?;
        let _ = learn(&joiner, &founder, how).await?;

        let (gid, did) = group_and_doc(&founder).await?;
        add_to_group(&founder, gid, phone_id).await?;
        for _ in 0..2 {
            exchange(&founder, founder_id, &phone, phone_id, &mut rng).await?;
        }

        // The pre-add epoch is minted by the phone, not the adder.
        let phone_chunk = encrypt(&phone, did, "chunk-phone", "written by the phone").await?;
        for _ in 0..2 {
            exchange(&founder, founder_id, &phone, phone_id, &mut rng).await?;
        }
        if decrypt(&founder, did, &phone_chunk).await.is_err() {
            return Err("precondition: founder cannot read the phone's chunk".to_string());
        }

        // Now enroll the joiner and rotate, as the engine does.
        add_to_group(&founder, gid, joiner_id).await?;
        force_rotate(&founder, did).await?;
        let post = encrypt(&founder, did, "chunk-post", "after the add").await?;

        let mut stuck = 0;
        for _ in 0..3 {
            exchange(&founder, founder_id, &phone, phone_id, &mut rng).await?;
            stuck = exchange(&founder, founder_id, &joiner, joiner_id, &mut rng).await?;
        }

        // The phone must still read (no regression for existing members) and
        // the joiner must read the post-add chunk.
        let phone_still = decrypt(&phone, did, &post).await;
        let note = format!(
            "stuck-events={stuck}; existing member reads post-add chunk: {}",
            match &phone_still {
                Ok(_) => "yes".to_string(),
                Err(e) => format!("NO ({e})"),
            }
        );
        let res = decrypt(&joiner, did, &post).await;
        Ok::<_, String>((check(res, "after the add"), note))
    }
    .await;
    match r {
        Ok(x) => x,
        Err(e) => (Outcome::Fail(format!("setup: {e}")), String::new()),
    }
}

/// (f) NEGATIVE CONTROL — reproduce the reported symptom *on purpose*, by
/// serving the joiner an event set computed before the add and rotation
/// happened, and never refreshing it.
///
/// This is the shape of the G4 cache hazard recorded in
/// `spikes/tasks-engine/README.md` ("`KeyhiveProtocol`'s event cache must be
/// refreshed after local ops"): keyhive is behaving correctly and the
/// embedder's delivery is stale. A PASS here means "the symptom is
/// reproducible from a delivery gap alone" — which is what makes the
/// attribution argument, since scenarios (a)–(e) show keyhive itself does
/// not produce it.
pub async fn scenario_stale_delivery(seed: u64, how: Materialize) -> (Outcome, String) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let r = async {
        let founder = Node::new("founder").await?;
        let joiner = Node::new("joiner").await?;
        let joiner_id = learn(&founder, &joiner, how).await?;
        let _ = learn(&joiner, &founder, how).await?;

        let (gid, did) = group_and_doc(&founder).await?;
        let _pre = encrypt(&founder, did, "chunk-pre", "before the add").await?;
        add_to_group(&founder, gid, joiner_id).await?;

        // Snapshot the event set HERE — before the rotation exists. This
        // stands in for a cache filled once and never refreshed.
        let stale = events_from(&founder, joiner_id, &mut rng).await?;

        force_rotate(&founder, did).await?;
        let post = encrypt(&founder, did, "chunk-post", "after the add").await?;

        // Deliver only the stale set, repeatedly. No refresh, ever.
        for _ in 0..3 {
            ingest(&joiner, stale.clone(), &mut rng).await;
        }

        match decrypt(&joiner, did, &post).await {
            Err(e) => Ok::<_, String>((
                Outcome::Pass,
                format!("symptom reproduced from the delivery gap alone: {e}"),
            )),
            Ok(_) => Ok((
                Outcome::Fail("stale delivery still decrypted".into()),
                String::new(),
            )),
        }
    }
    .await;
    match r {
        Ok(x) => x,
        Err(e) => (Outcome::Fail(format!("setup: {e}")), String::new()),
    }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

pub struct Row {
    pub name: String,
    pub passes: usize,
    pub n: usize,
}

pub async fn run_all(n: usize, rev_label: &str) -> Vec<Row> {
    let mut rows = Vec::new();
    for how in [Materialize::Direct, Materialize::Card] {
        let tag = match how {
            Materialize::Direct => "direct",
            Materialize::Card => "card",
        };
        for (name, f) in scenario_table() {
            let mut passes = 0;
            let mut details = Vec::new();
            for seed in 0..n as u64 {
                let (outcome, note) = f(seed, how).await;
                if outcome.is_pass() {
                    passes += 1;
                }
                details.push(format!(
                    "seed {seed}: {} — {} {}",
                    if outcome.is_pass() { "PASS" } else { "FAIL" },
                    outcome.detail(),
                    note
                ));
            }
            println!("[{rev_label}/{tag}] {name}: {passes}/{n} pass");
            for d in &details {
                println!("    {d}");
            }
            rows.push(Row {
                name: format!("{name} ({tag})"),
                passes,
                n,
            });
        }
    }
    rows
}

type ScenarioFn = fn(u64, Materialize) -> std::pin::Pin<Box<dyn std::future::Future<Output = (Outcome, String)>>>;

macro_rules! boxed {
    ($f:path) => {{
        fn wrapper(
            seed: u64,
            how: Materialize,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = (Outcome, String)>>> {
            Box::pin($f(seed, how))
        }
        wrapper as ScenarioFn
    }};
}

fn scenario_table() -> Vec<(&'static str, ScenarioFn)> {
    vec![
        ("a CORE post-add readability", boxed!(scenario_core)),
        (
            "a2 CORE incremental delivery",
            boxed!(scenario_core_incremental),
        ),
        ("b CONTROL member before seal", boxed!(scenario_control)),
        ("c DIRECTION joiner writes", boxed!(scenario_direction)),
        (
            "d PENDING foreign-group delegation",
            boxed!(scenario_pending_delegation),
        ),
        ("e MULTI-DEVICE existing member authored", boxed!(scenario_multidevice)),
        (
            "f NEGATIVE stale event set (pass = symptom reproduced)",
            boxed!(scenario_stale_delivery),
        ),
    ]
}

/// Entry point shared by both runner crates.
pub fn main_for(rev_label: &'static str) {
    let n: usize = std::env::var("N").ok().and_then(|s| s.parse().ok()).unwrap_or(10);
    // Current-thread on purpose: the harness futures are `Local` (keyhive's
    // signer trait objects are not `Send`), and single-threaded execution
    // also keeps the op-interleaving deterministic per seed.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let rows = rt.block_on(run_all(n, rev_label));

    println!("\n## Results — keyhive {rev_label} (N={n} per scenario)\n");
    println!("| scenario | pass | fail |");
    println!("| --- | --- | --- |");
    for r in &rows {
        println!("| {} | {} | {} |", r.name, r.passes, r.n - r.passes);
    }

    // Exit non-zero only if the CONTROL scenario regressed: the CORE
    // scenario failing is the finding under investigation, not a broken
    // harness, so it must not mask the control signal.
    let control_ok = rows
        .iter()
        .filter(|r| r.name.starts_with("b CONTROL"))
        .all(|r| r.passes == r.n);
    if !control_ok {
        eprintln!("CONTROL scenario did not hold — the harness itself is suspect");
        std::process::exit(2);
    }
}
