//! The engine spike (#20 G2): the walking skeleton's content spine
//! generalized to the real automerge change DAG, serving the
//! `polymorph-data:tasks@0.1.0` data service from inside the engine
//! composite.
//!
//! One DAG across three layers: chunk identity = automerge `ChangeHash`;
//! chunk parents = the change's `deps()` = keyhive predecessor refs =
//! sedimentree parents. Authoring merges remote changes first (so deps
//! capture the frontier), commits one automerge change, seals it under the
//! current BeeKEM epoch, and commits the envelope to the sedimentree.
//! Reading applies newly synced chunks in causal order; chunks the current
//! epoch cannot decrypt (revoked readers) are counted and skipped.
//!
//! Everything else — one platform-held identity backing keyhive and
//! subduction, the subduction_keyhive bridge on a second QUIC stream, the
//! keyhive-gated pull policy — is the skeleton spike unchanged.

wit_bindgen::generate!({
    path: "wit",
    world: "spike",
    generate_all,
});

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use automerge::transaction::Transactable;
use automerge::{AutoCommit, Change, ObjType, ReadDoc, ScalarValue, Value, ROOT};
use ed25519_dalek::VerifyingKey as DalekVerifyingKey;
use future_form::{FutureForm, Local};
use futures::future::{AbortHandle, Abortable, LocalBoxFuture};

use polymorph_webcrypto_guest::{ed25519, SigningKey, SigningKeyOptions};

use beekem::encrypted::EncryptedContent;
use keyhive_core::access::Access;
use keyhive_core::event::static_event::StaticEvent;
use keyhive_core::keyhive::Keyhive;
use keyhive_core::listener::no_listener::NoListener;
use keyhive_core::principal::document::id::DocumentId;
use keyhive_core::principal::group::id::GroupId;
use keyhive_core::principal::identifier::Identifier;
use keyhive_core::principal::membered::Membered;
use keyhive_core::store::ciphertext::memory::MemoryCiphertextStore;
use keyhive_crypto::signed::SigningError;
use keyhive_crypto::signer::async_signer::AsyncSigner;
use keyhive_crypto::verifiable::Verifiable;

use sedimentree_core::{
    blob::Blob, depth::CountLeadingZeroBytes, id::SedimentreeId, loose_commit::id::CommitId,
    loose_commit::LooseCommit,
};
use subduction_core::{
    handler::sync::SyncHandler,
    handshake::{self, audience::Audience, Handshake},
    nonce_cache::NonceCache,
    peer::id::PeerId,
    spawn::Spawn,
    storage::{memory::MemoryStorage, traits::Storage},
    subduction::{builder::SubductionBuilder, Subduction},
    timeout::{call::CallTimeout, TimedOut, Timeout},
    timestamp::TimestampSeconds,
    transport::{message::MessageTransport, Transport},
};
use subduction_crypto::{nonce::Nonce, signer::Signer};
use subduction_keyhive::connection::KeyhiveConnection;
use subduction_keyhive::peer_id::KeyhivePeerId;
use subduction_keyhive::policy::SubductionKeyhive;
use subduction_keyhive::protocol::KeyhiveProtocol;
use subduction_keyhive::signed_message::SignedMessage;
use subduction_keyhive::storage::MemoryKeyhiveStorage;

use exports::polymorph::engine_spike::driver::Guest as DriverGuest;
use exports::polymorph_data::tasks::tasks::{Guest as TasksGuest, Snapshot, TodoItem};
use polymorph::iroh::endpoint::{Endpoint, EndpointOptions, RecvStream, SendStream};
use polymorph::iroh::identity_generate;
use polymorph::iroh::types::{EndpointAddr, TransportAddr};

/// The iroh ALPN for the engine's subduction wire.
const ALPN: &[u8] = b"engine-spike/0";

// --- types ---

type T = [u8; 32];
type P = Vec<u8>;
type KhStore = MemoryCiphertextStore<T, P>;
type Kh = Keyhive<Local, WebcryptoSigner, T, P, KhStore, NoListener, rand::rngs::OsRng>;

type Auth = SubductionKeyhive<Local, WebcryptoSigner, T, P, KhStore, NoListener, rand::rngs::OsRng>;
type Conn = MessageTransport<QueueTransport>;
type Hdl = SyncHandler<Local, MemoryStorage, Conn, Auth, CountLeadingZeroBytes, WitSpawn, 256>;
type Sd = Subduction<
    'static,
    Local,
    MemoryStorage,
    Conn,
    Hdl,
    Auth,
    WebcryptoSigner,
    NeverTimeout,
    WitSpawn,
    CountLeadingZeroBytes,
    256,
>;
type KhProto = KeyhiveProtocol<
    WebcryptoSigner,
    T,
    P,
    KhStore,
    NoListener,
    rand::rngs::OsRng,
    KhWire,
    MemoryKeyhiveStorage,
    Local,
>;

// --- one signer, two traits ---

struct SignerInner {
    key: SigningKey,
    verifying: DalekVerifyingKey,
    sign_count: Cell<u64>,
}

#[derive(Clone)]
struct WebcryptoSigner(Rc<SignerInner>);

impl std::fmt::Debug for WebcryptoSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebcryptoSigner")
            .field("verifying", &hex::encode(self.0.verifying.to_bytes()))
            .finish()
    }
}

impl Verifiable for WebcryptoSigner {
    fn verifying_key(&self) -> DalekVerifyingKey {
        self.0.verifying
    }
}

impl AsyncSigner<Local> for WebcryptoSigner {
    fn try_sign_bytes_async<'a>(
        &'a self,
        payload_bytes: &'a [u8],
    ) -> LocalBoxFuture<'a, Result<ed25519_dalek::Signature, SigningError>> {
        Box::pin(async move {
            self.0.sign_count.set(self.0.sign_count.get() + 1);
            let sig = self
                .0
                .key
                .sign(payload_bytes)
                .await
                .map_err(|_| SigningError::SigningFailed(ed25519_dalek::SignatureError::new()))?;
            ed25519_dalek::Signature::from_slice(&sig).map_err(SigningError::SigningFailed)
        })
    }
}

impl Signer<Local> for WebcryptoSigner {
    fn sign(&self, message: &[u8]) -> LocalBoxFuture<'_, ed25519_dalek::Signature> {
        let message = message.to_vec();
        Box::pin(async move {
            self.0.sign_count.set(self.0.sign_count.get() + 1);
            let sig = self
                .0
                .key
                .sign(message.as_slice())
                .await
                .expect("webcrypto signing failed (Signer trait is infallible)");
            ed25519_dalek::Signature::from_slice(&sig).expect("64-byte signature")
        })
    }

    fn verifying_key(&self) -> DalekVerifyingKey {
        self.0.verifying
    }
}

// --- spawn + timeout ---

#[derive(Clone, Debug, PartialEq)]
struct WitSpawn;

impl Spawn<Local> for WitSpawn {
    fn spawn(&self, fut: <Local as FutureForm>::Future<'static, ()>) -> AbortHandle {
        let (handle, reg) = AbortHandle::new_pair();
        wit_bindgen::spawn_local(async move {
            let _ = Abortable::new(fut, reg).await;
        });
        handle
    }
}

#[derive(Clone, Debug, PartialEq)]
struct NeverTimeout;

impl Timeout<Local> for NeverTimeout {
    fn timeout<'a, T2: 'a>(
        &'a self,
        _dur: Duration,
        fut: <Local as FutureForm>::Future<'a, T2>,
    ) -> <Local as FutureForm>::Future<'a, Result<T2, TimedOut>> {
        Box::pin(async move { Ok(fut.await) })
    }
}

// --- the frame-queue transport (fed by iroh stream pumps) ---

#[derive(Debug)]
struct ChannelClosed(&'static str);

impl std::fmt::Display for ChannelClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "queue channel closed ({})", self.0)
    }
}

impl std::error::Error for ChannelClosed {}

#[derive(Clone, Debug)]
struct QueueTransport {
    id: u32,
    out_tx: async_channel::Sender<Vec<u8>>,
    out_rx: async_channel::Receiver<Vec<u8>>,
    in_tx: async_channel::Sender<Vec<u8>>,
    in_rx: async_channel::Receiver<Vec<u8>>,
}

impl PartialEq for QueueTransport {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl QueueTransport {
    fn new(id: u32) -> Self {
        let (out_tx, out_rx) = async_channel::unbounded();
        let (in_tx, in_rx) = async_channel::unbounded();
        Self {
            id,
            out_tx,
            out_rx,
            in_tx,
            in_rx,
        }
    }
}

impl Transport<Local> for QueueTransport {
    type SendError = ChannelClosed;
    type RecvError = ChannelClosed;
    type DisconnectionError = ChannelClosed;

    fn send_bytes(&self, bytes: &[u8]) -> LocalBoxFuture<'_, Result<(), ChannelClosed>> {
        let frame = bytes.to_vec();
        Box::pin(async move {
            self.out_tx
                .send(frame)
                .await
                .map_err(|_| ChannelClosed("send"))
        })
    }

    fn recv_bytes(&self) -> LocalBoxFuture<'_, Result<Vec<u8>, ChannelClosed>> {
        Box::pin(async move { self.in_rx.recv().await.map_err(|_| ChannelClosed("recv")) })
    }

    fn disconnect(&self) -> LocalBoxFuture<'_, Result<(), ChannelClosed>> {
        Box::pin(async move {
            self.out_tx.close();
            self.in_rx.close();
            Ok(())
        })
    }
}

#[derive(Debug)]
struct KhWireError(String);

impl std::fmt::Display for KhWireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "keyhive wire: {}", self.0)
    }
}

impl std::error::Error for KhWireError {}

#[derive(Clone, Debug)]
struct KhWire {
    peer: KeyhivePeerId,
    out_tx: async_channel::Sender<Vec<u8>>,
    in_rx: async_channel::Receiver<Vec<u8>>,
}

impl KeyhiveConnection<Local> for KhWire {
    type SendError = KhWireError;
    type RecvError = KhWireError;
    type DisconnectError = KhWireError;

    fn peer_id(&self) -> KeyhivePeerId {
        self.peer.clone()
    }

    fn send(&self, message: SignedMessage) -> LocalBoxFuture<'_, Result<(), KhWireError>> {
        Box::pin(async move {
            let bytes =
                bincode::serialize(&message).map_err(|e| KhWireError(format!("encode: {e}")))?;
            self.out_tx
                .send(bytes)
                .await
                .map_err(|_| KhWireError("closed".into()))
        })
    }

    fn recv(&self) -> LocalBoxFuture<'_, Result<SignedMessage, KhWireError>> {
        Box::pin(async move {
            let bytes = self
                .in_rx
                .recv()
                .await
                .map_err(|_| KhWireError("closed".into()))?;
            bincode::deserialize(&bytes).map_err(|e| KhWireError(format!("decode: {e}")))
        })
    }

    fn disconnect(&self) -> LocalBoxFuture<'_, Result<(), KhWireError>> {
        Box::pin(async move {
            self.out_tx.close();
            self.in_rx.close();
            Ok(())
        })
    }
}

struct QueueHandshake(QueueTransport);

impl Handshake<Local> for QueueHandshake {
    type Error = ChannelClosed;

    fn send(&mut self, bytes: Vec<u8>) -> LocalBoxFuture<'_, Result<(), ChannelClosed>> {
        Box::pin(async move {
            self.0
                .out_tx
                .send(bytes)
                .await
                .map_err(|_| ChannelClosed("hs send"))
        })
    }

    fn recv(&mut self) -> LocalBoxFuture<'_, Result<Vec<u8>, ChannelClosed>> {
        Box::pin(async move { self.0.in_rx.recv().await.map_err(|_| ChannelClosed("hs recv")) })
    }
}

// --- instance state ---

/// One partition's live replica.
struct Partition {
    am: AutoCommit,
    /// Chunk crefs (automerge change hashes) already applied.
    applied: HashSet<[u8; 32]>,
    /// Monotonic per-replica revision: applied-change count.
    revision: u64,
    /// Chunks seen in the sedimentree but undecryptable under held epochs.
    undecryptable: u32,
}

struct State {
    kh: Kh,
    sd: Arc<Sd>,
    sd_storage: MemoryStorage,
    signer: WebcryptoSigner,
    my_peer: PeerId,
    nonce_cache: Rc<NonceCache>,
    proto: Rc<KhProto>,
    conn_results: HashMap<u32, Result<String, String>>,
    syncs: HashMap<u32, Result<String, String>>,
    endpoint: Option<Rc<Endpoint>>,
    iroh_identity: Option<Rc<polymorph::iroh::identity::Identity>>,
    iroh_conns: HashMap<u32, Rc<polymorph::iroh::endpoint::Connection>>,
    partitions: HashMap<Vec<u8>, Partition>,
    /// Creation changes awaiting `seal-partition`.
    pending: HashMap<Vec<u8>, (Vec<u8>, [u8; 32])>,
    /// The partition the tasks service is bound to.
    active: Option<Vec<u8>>,
    /// Rate limiter for `nudge_keyhive_sync` (fires when it reaches 0).
    kh_nudge: u32,
    next_id: u32,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> Result<R, String> {
    STATE.with(|s| {
        s.borrow_mut()
            .as_mut()
            .map(f)
            .ok_or_else(|| "not initialized (call init first)".to_string())
    })
}

fn now_ts() -> TimestampSeconds {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_secs();
    TimestampSeconds::new(secs)
}

fn arr32(bytes: &[u8], what: &str) -> Result<[u8; 32], String> {
    bytes
        .try_into()
        .map_err(|_| format!("{what} must be 32 bytes"))
}

fn kh_doc_id(bytes: &[u8]) -> Result<DocumentId, String> {
    Ok(DocumentId::from(identifier(bytes)?))
}

fn identifier(bytes: &[u8]) -> Result<Identifier, String> {
    let arr = arr32(bytes, "agent id")?;
    let vk = DalekVerifyingKey::from_bytes(&arr).map_err(|e| format!("bad agent id: {e:?}"))?;
    Ok(Identifier::from(vk))
}

fn parse_access(level: &str) -> Result<Access, String> {
    match level {
        "read" => Ok(Access::Read),
        "edit" => Ok(Access::Edit),
        "admin" => Ok(Access::Admin),
        other => Err(format!("unknown access level {other}")),
    }
}

fn tree_id(bytes: &[u8]) -> Result<SedimentreeId, String> {
    Ok(SedimentreeId::new(arr32(bytes, "tree id")?))
}

async fn breathe() {
    wit_bindgen::yield_async().await;
    wit_bindgen::yield_async().await;
}

/// Refresh the bridge's event cache, then sync.
///
/// Finding (this spike): `KeyhiveProtocol::sync_keyhive` serves the
/// per-peer event set from a `PeriodicEventCache` once one exists.
/// Upstream's runtime refreshes that cache on an interval; an embedder
/// that skips the runtime (us) and creates keyhive ops locally (member
/// changes, encrypt-time CGKA rotations) must refresh before syncing, or
/// every op created after the cache first fills is silently never offered
/// to peers — post-revocation rotations never reach remaining members,
/// and their decrypts fail `KeyNotFound` forever.
async fn refreshed_sync(
    proto: &KhProto,
    target: Option<&KeyhivePeerId>,
) -> Result<(), String> {
    proto
        .refresh_cache()
        .await
        .map_err(|e| format!("refresh cache: {e:?}"))?;
    proto
        .sync_keyhive(target)
        .await
        .map_err(|e| format!("sync keyhive: {e:?}"))
}

/// Rate-limited keyhive re-sync, driven by read polls that find themselves
/// still waiting on keyhive state (missing doc, undecryptable chunks).
///
/// The bridge's syncs are one-shot request/response rounds with no retry;
/// upstream runs them from a periodic runtime loop. A lost or ill-timed
/// round would otherwise strand a member forever.
async fn nudge_keyhive_sync() {
    let fire = with_state(|s| {
        if s.kh_nudge == 0 {
            s.kh_nudge = 20;
            true
        } else {
            s.kh_nudge -= 1;
            false
        }
    })
    .unwrap_or(false);
    if fire {
        if let Ok(proto) = with_state(|s| s.proto.clone()) {
            if let Err(e) = refreshed_sync(&proto, None).await {
                eprintln!("[kh nudge] {e}");
            }
        }
    }
}

// --- shared handshake + iroh pumps (unchanged from the skeleton) ---

#[allow(clippy::too_many_arguments)]
async fn subduction_handshake(
    transport: QueueTransport,
    initiator: bool,
    expected_peer: Vec<u8>,
    sd: Arc<Sd>,
    signer: WebcryptoSigner,
    my_peer: PeerId,
    nonce_cache: Rc<NonceCache>,
) -> Result<String, String> {
    let now = now_ts();
    let result = if initiator {
        let expected = arr32(&expected_peer, "expected peer")?;
        let audience = Audience::known(PeerId::new(expected));
        let nonce = Nonce::from_bytes(rand::random::<[u8; 16]>());
        handshake::initiate::<Local, _, _, _, _>(
            QueueHandshake(transport),
            |h, _peer| (MessageTransport::new(h.0), ()),
            &signer,
            audience,
            now,
            nonce,
        )
        .await
        .map_err(|e| format!("initiate: {e:?}"))
    } else {
        handshake::respond::<Local, _, _, _, _>(
            QueueHandshake(transport),
            |h, _peer| (MessageTransport::new(h.0), ()),
            &signer,
            &nonce_cache,
            my_peer,
            None,
            now,
            Duration::from_secs(300),
        )
        .await
        .map_err(|e| format!("respond: {e:?}"))
    };

    match result {
        Ok((authenticated, ())) => {
            let peer_hex = authenticated.peer_id().to_string();
            match sd.add_connection(authenticated).await {
                Ok(_) => Ok(peer_hex),
                Err(e) => Err(format!("add_connection: {e:?}")),
            }
        }
        Err(e) => Err(e),
    }
}

async fn iroh_writer(out_rx: async_channel::Receiver<Vec<u8>>, send: SendStream) {
    while let Ok(frame) = out_rx.recv().await {
        let mut buf = Vec::with_capacity(4 + frame.len());
        buf.extend_from_slice(&(frame.len() as u32).to_le_bytes());
        buf.extend_from_slice(&frame);
        if send.write(buf).await.is_err() {
            break;
        }
    }
    let _ = send.finish();
}

async fn iroh_reader(in_tx: async_channel::Sender<Vec<u8>>, recv: RecvStream, seed: Vec<u8>) {
    let mut buf: Vec<u8> = seed;
    loop {
        while buf.len() >= 4 {
            let len = u32::from_le_bytes(buf[0..4].try_into().expect("4 bytes")) as usize;
            if buf.len() < 4 + len {
                break;
            }
            let frame: Vec<u8> = buf[4..4 + len].to_vec();
            buf.drain(0..4 + len);
            if in_tx.send(frame).await.is_err() {
                return;
            }
        }
        match recv.read(64 * 1024).await {
            Ok(Some(chunk)) => buf.extend_from_slice(&chunk),
            Ok(None) | Err(_) => break,
        }
    }
}

// --- the DAG content spine ---

/// Encrypt one automerge change under the doc's current epoch and commit
/// its envelope to the sedimentree with the change's deps as parents. Any
/// CGKA update the encryption produced is synced over the bridge.
async fn encrypt_and_commit(
    id: &[u8],
    chunk: Vec<u8>,
    preds: Vec<[u8; 32]>,
    cref: [u8; 32],
) -> Result<(), String> {
    let (kh, sd, proto) = with_state(|s| (s.kh.clone(), s.sd.clone(), s.proto.clone()))?;
    let did = kh_doc_id(id)?;
    let doc = kh
        .get_document(did)
        .await
        .ok_or("keyhive doc not found".to_string())?;
    let out = kh
        .try_encrypt_content(doc, &cref, &preds, &chunk)
        .await
        .map_err(|e| format!("encrypt: {e:?}"))?;
    let envelope =
        bincode::serialize(out.encrypted_content()).map_err(|e| format!("serialize: {e}"))?;
    let had_update = out.update_op().is_some();
    let tree = tree_id(id)?;
    let parents: BTreeSet<CommitId> = preds.into_iter().map(CommitId::new).collect();
    sd.add_commit(tree, CommitId::new(cref), parents, Blob::new(envelope))
        .await
        .map_err(|e| format!("add_commit: {e:?}"))?;
    if had_update {
        refreshed_sync(&proto, None).await?;
    }
    breathe().await;
    Ok(())
}

/// Causal order: parents before children, ties by head bytes.
fn causal_order(mut commits: Vec<LooseCommit>) -> Vec<LooseCommit> {
    let mut done: HashSet<CommitId> = HashSet::new();
    let mut out = Vec::new();
    while !commits.is_empty() {
        let mut ready: Vec<LooseCommit> = Vec::new();
        let mut rest: Vec<LooseCommit> = Vec::new();
        for c in commits {
            if c.parents().iter().all(|p| done.contains(p)) {
                ready.push(c);
            } else {
                rest.push(c);
            }
        }
        if ready.is_empty() {
            rest.sort_by_key(|c| *c.head().as_bytes());
            out.extend(rest);
            break;
        }
        ready.sort_by_key(|c| *c.head().as_bytes());
        for c in ready {
            done.insert(c.head());
            out.push(c);
        }
        commits = rest;
    }
    out
}

/// Apply every newly synced, decryptable chunk to the partition's replica,
/// in causal order. Undecryptable chunks (epochs this member does not
/// hold) are counted and left unapplied.
async fn apply_new_chunks(id: &[u8]) -> Result<(), String> {
    breathe().await;
    let (kh, sd, storage) =
        with_state(|s| (s.kh.clone(), s.sd.clone(), s.sd_storage.clone()))?;
    let tree = tree_id(id)?;
    let did = kh_doc_id(id)?;

    let commits = sd.get_commits(tree).await.unwrap_or_default();
    let already = with_state(|s| {
        s.partitions
            .get(id)
            .map(|p| p.applied.clone())
            .ok_or("unknown partition".to_string())
    })??;
    let pending: Vec<LooseCommit> = causal_order(commits)
        .into_iter()
        .filter(|c| !already.contains(c.head().as_bytes()))
        .collect();
    if pending.is_empty() {
        return Ok(());
    }

    let Some(kh_doc) = kh.get_document(did).await else {
        // Commits are here but keyhive hasn't learned the doc yet: not an
        // error, just not-synced-yet. Ask the bridge to try again.
        eprintln!(
            "[apply] {} commits waiting, keyhive doc unknown; nudging",
            pending.len()
        );
        nudge_keyhive_sync().await;
        return Ok(());
    };

    let mut changes: Vec<Change> = Vec::new();
    let mut applied_now: Vec<[u8; 32]> = Vec::new();
    let mut undecryptable = 0u32;
    for commit in pending {
        let verified =
            <MemoryStorage as Storage<Local>>::load_loose_commit(&storage, tree, commit.head())
                .await
                .map_err(|e| format!("load: {e:?}"))?
                .ok_or("commit blob not found")?;
        let envelope: EncryptedContent<P, T> = bincode::deserialize(verified.blob().as_slice())
            .map_err(|e| format!("bad envelope: {e}"))?;
        match kh.try_decrypt_content(kh_doc.clone(), &envelope).await {
            Ok(plain) => {
                let change =
                    Change::from_bytes(plain).map_err(|e| format!("bad change: {e}"))?;
                applied_now.push(*commit.head().as_bytes());
                changes.push(change);
            }
            Err(e) => {
                if undecryptable == 0 {
                    eprintln!(
                        "[decrypt] chunk {} undecryptable: {e:?}",
                        hex::encode(&commit.head().as_bytes()[..8]),
                    );
                }
                undecryptable += 1;
            }
        }
    }

    with_state(|s| -> Result<(), String> {
        let p = s.partitions.get_mut(id).ok_or("unknown partition")?;
        if !changes.is_empty() {
            let n = changes.len() as u64;
            p.am.apply_changes(changes)
                .map_err(|e| format!("apply: {e}"))?;
            p.applied.extend(applied_now.iter().copied());
            p.revision += n;
        }
        p.undecryptable = undecryptable;
        Ok(())
    })??;
    if undecryptable > 0 {
        // Waiting on epoch material (e.g. a post-revocation rotation op):
        // ask the bridge to try again.
        nudge_keyhive_sync().await;
    }
    Ok(())
}

/// Merge remote changes, run one mutation as a single automerge change,
/// seal it, and commit it to the DAG.
async fn author<R>(
    id: &[u8],
    mutate: impl FnOnce(&mut AutoCommit) -> Result<R, String>,
) -> Result<R, String> {
    apply_new_chunks(id).await?;
    let (result, chunk, cref, deps) = with_state(|s| -> Result<_, String> {
        let p = s.partitions.get_mut(id).ok_or("unknown partition")?;
        let result = mutate(&mut p.am)?;
        p.am.commit();
        let change = p
            .am
            .get_last_local_change()
            .ok_or("mutation produced no change")?;
        let cref = change.hash().0;
        let deps: Vec<[u8; 32]> = change.deps().iter().map(|h| h.0).collect();
        let chunk = change.raw_bytes().to_vec();
        p.applied.insert(cref);
        p.revision += 1;
        Ok((result, chunk, cref, deps))
    })??;
    encrypt_and_commit(id, chunk, deps, cref).await?;
    Ok(result)
}

fn active_partition() -> Result<Vec<u8>, String> {
    with_state(|s| s.active.clone())?.ok_or("no partition bound (seal or adopt first)".into())
}

fn todos_object(am: &AutoCommit) -> Result<automerge::ObjId, String> {
    match am.get(ROOT, "todos").map_err(|e| format!("get todos: {e}"))? {
        Some((Value::Object(ObjType::Map), id)) => Ok(id),
        _ => Err("no todos map (creation chunk not applied)".into()),
    }
}

fn read_snapshot(am: &AutoCommit) -> Result<Vec<TodoItem>, String> {
    // No todos map yet: an adopted partition whose creation chunk has not
    // arrived (or not become decryptable) is an empty list at revision 0.
    let Ok(todos) = todos_object(am) else {
        return Ok(Vec::new());
    };
    let mut items = Vec::new();
    for key in am.keys(&todos) {
        let Some((Value::Object(_), item)) =
            am.get(&todos, &key).map_err(|e| format!("get item: {e}"))?
        else {
            continue;
        };
        let title = match am.get(&item, "title").map_err(|e| e.to_string())? {
            Some((Value::Scalar(s), _)) => match s.into_owned() {
                ScalarValue::Str(t) => t.to_string(),
                other => format!("{other:?}"),
            },
            _ => String::new(),
        };
        let completed = matches!(
            am.get(&item, "completed").map_err(|e| e.to_string())?,
            Some((Value::Scalar(s), _)) if matches!(s.as_ref(), ScalarValue::Boolean(true))
        );
        items.push(TodoItem {
            id: key.to_string(),
            title,
            completed,
        });
    }
    items.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(items)
}

// --- the exported driver ---

struct Component;

impl DriverGuest for Component {
    async fn init() -> Result<String, String> {
        let options = SigningKeyOptions {
            sign: true,
            extractable: false,
        };
        let (key, vk) = ed25519::generate_key(options)
            .await
            .map_err(|e| format!("webcrypto generate-key: {e}"))?;
        let vk_raw = vk
            .export_key_raw()
            .await
            .map_err(|e| format!("webcrypto export verifying key: {e}"))?;
        let verifying = DalekVerifyingKey::from_bytes(&arr32(&vk_raw, "verifying key")?)
            .map_err(|e| format!("parse verifying key: {e:?}"))?;
        let signer = WebcryptoSigner(Rc::new(SignerInner {
            key,
            verifying,
            sign_count: Cell::new(0),
        }));
        let my_peer = PeerId::from(verifying);

        let kh = Kh::generate(
            signer.clone(),
            MemoryCiphertextStore::new(),
            NoListener,
            rand::rngs::OsRng,
        )
        .await
        .map_err(|e| format!("keyhive generate: {e:?}"))?;

        let card = kh
            .contact_card()
            .await
            .map_err(|e| format!("contact card: {e:?}"))?;
        #[allow(clippy::arc_with_non_send_sync)] // upstream APIs take Arc; single-threaded wasm
        let shared_kh = Arc::new(async_lock::Mutex::new(kh.clone()));
        let proto: Rc<KhProto> = Rc::new(KeyhiveProtocol::new(
            shared_kh,
            MemoryKeyhiveStorage::new(),
            KeyhivePeerId::from_bytes(verifying.to_bytes()),
            card,
        ));

        let sd_storage = MemoryStorage::new();
        #[allow(clippy::arc_with_non_send_sync)] // upstream APIs take Arc; single-threaded wasm
        let policy = Arc::new(SubductionKeyhive::new(kh.clone()));
        let (sd, _handler, listener, manager) = SubductionBuilder::new()
            .signer(signer.clone())
            .storage(sd_storage.clone(), policy)
            .spawner(WitSpawn)
            .timer(NeverTimeout)
            .build::<Local, Conn>();
        wit_bindgen::spawn_local(async move {
            let _ = listener.await;
        });
        wit_bindgen::spawn_local(async move {
            let _ = manager.await;
        });

        STATE.with(|s| {
            *s.borrow_mut() = Some(State {
                kh,
                sd,
                sd_storage,
                signer,
                my_peer,
                nonce_cache: Rc::new(NonceCache::default()),
                proto,
                conn_results: HashMap::new(),
                syncs: HashMap::new(),
                endpoint: None,
                iroh_identity: None,
                iroh_conns: HashMap::new(),
                partitions: HashMap::new(),
                pending: HashMap::new(),
                active: None,
                kh_nudge: 0,
                next_id: 0,
            })
        });
        Ok(hex::encode(verifying.to_bytes()))
    }

    async fn kh_knows_agent(agent: Vec<u8>) -> Result<bool, String> {
        breathe().await;
        let kh = with_state(|s| s.kh.clone())?;
        Ok(kh.get_agent(identifier(&agent)?).await.is_some())
    }

    async fn kh_create_group() -> Result<Vec<u8>, String> {
        let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
        let group = kh
            .generate_group(vec![])
            .await
            .map_err(|e| format!("generate group: {e:?}"))?;
        let id = { group.lock().await.group_id().to_bytes().to_vec() };
        refreshed_sync(&proto, None).await?;
        Ok(id)
    }

    async fn kh_add_to_group(
        group_id: Vec<u8>,
        member: Vec<u8>,
        level: String,
    ) -> Result<(), String> {
        let access = parse_access(&level)?;
        let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
        let gid = GroupId::new(identifier(&group_id)?);
        let group = kh
            .get_group(gid)
            .await
            .ok_or("group not found".to_string())?;
        let agent = kh
            .get_agent(identifier(&member)?)
            .await
            .ok_or("member agent not found (no card yet)".to_string())?;
        kh.add_member(agent, &Membered::Group(gid, group), access, &[])
            .await
            .map_err(|e| format!("add to group: {e:?}"))?;
        refreshed_sync(&proto, None).await?;
        Ok(())
    }

    async fn kh_revoke_from_group(group_id: Vec<u8>, member: Vec<u8>) -> Result<(), String> {
        let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
        let gid = GroupId::new(identifier(&group_id)?);
        let group = kh
            .get_group(gid)
            .await
            .ok_or("group not found".to_string())?;
        kh.revoke_member(identifier(&member)?, true, &Membered::Group(gid, group))
            .await
            .map_err(|e| format!("revoke from group: {e:?}"))?;
        refreshed_sync(&proto, None).await?;
        Ok(())
    }

    async fn kh_export_card(agent_id: Vec<u8>) -> Result<Vec<u8>, String> {
        let kh = with_state(|s| s.kh.clone())?;
        let agent = kh
            .get_agent(identifier(&agent_id)?)
            .await
            .ok_or("agent not found".to_string())?;
        let events: Vec<StaticEvent<T>> = kh
            .static_events_for_agent(&agent)
            .await
            .into_values()
            .collect();
        bincode::serialize(&events).map_err(|e| format!("serialize card: {e}"))
    }

    async fn kh_ingest_card(card: Vec<u8>) -> Result<u32, String> {
        let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
        let events: Vec<StaticEvent<T>> =
            bincode::deserialize(&card).map_err(|e| format!("bad card: {e}"))?;
        let pending = kh.ingest_unsorted_static_events(events).await;
        refreshed_sync(&proto, None).await?;
        Ok(pending.len() as u32)
    }

    async fn kh_add_member(doc_id: Vec<u8>, agent_id: Vec<u8>, level: String) -> Result<(), String> {
        let access = parse_access(&level)?;
        let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
        let did = kh_doc_id(&doc_id)?;
        let agent = kh
            .get_agent(identifier(&agent_id)?)
            .await
            .ok_or("agent not found (bridge has not synced its card yet)".to_string())?;
        let doc = kh
            .get_document(did)
            .await
            .ok_or("doc not found".to_string())?;
        kh.add_member(agent, &Membered::Document(did, doc), access, &[])
            .await
            .map_err(|e| format!("add member: {e:?}"))?;
        refreshed_sync(&proto, None).await?;
        Ok(())
    }

    async fn kh_revoke_member(doc_id: Vec<u8>, agent_id: Vec<u8>) -> Result<(), String> {
        let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
        let did = kh_doc_id(&doc_id)?;
        let doc = kh
            .get_document(did)
            .await
            .ok_or("doc not found".to_string())?;
        kh.revoke_member(identifier(&agent_id)?, true, &Membered::Document(did, doc))
            .await
            .map_err(|e| format!("revoke member: {e:?}"))?;
        refreshed_sync(&proto, None).await?;
        Ok(())
    }

    async fn iroh_bind(relay_url: String) -> Result<String, String> {
        let identity = identity_generate::generate()
            .await
            .map_err(|e| format!("identity-generate: {e:?}"))?;
        let options = EndpointOptions::new(&identity);
        options.add_alpn(ALPN);
        options.relay_url(&relay_url);
        let endpoint = Endpoint::bind(options)
            .await
            .map_err(|e| format!("bind: {e:?}"))?;
        let id = endpoint.id();
        with_state(|s| {
            s.endpoint = Some(Rc::new(endpoint));
            s.iroh_identity = Some(Rc::new(identity));
        })?;
        Ok(hex::encode(id))
    }

    async fn iroh_start(
        initiator: bool,
        peer_endpoint_id: Vec<u8>,
        relay_url: String,
        expected_peer: Vec<u8>,
    ) -> Result<u32, String> {
        let (id, sd, signer, my_peer, nonce_cache, endpoint) = with_state(|s| {
            let id = s.next_id;
            s.next_id += 1;
            (
                id,
                s.sd.clone(),
                s.signer.clone(),
                s.my_peer,
                s.nonce_cache.clone(),
                s.endpoint.clone(),
            )
        })?;
        let endpoint = endpoint.ok_or("iroh-bind first")?;
        let proto = with_state(|s| s.proto.clone())?;

        wit_bindgen::spawn_local(async move {
            let wire = async {
                if initiator {
                    let conn = endpoint
                        .connect(
                            EndpointAddr {
                                endpoint_id: peer_endpoint_id,
                                addrs: vec![TransportAddr::Relay(relay_url)],
                            },
                            ALPN.to_vec(),
                        )
                        .await
                        .map_err(|e| format!("connect: {e:?}"))?;
                    let (s_send, s_recv) =
                        conn.open_bi().await.map_err(|e| format!("open-bi S: {e:?}"))?;
                    s_send
                        .write(vec![b'S'])
                        .await
                        .map_err(|e| format!("tag S: {e:?}"))?;
                    let (k_send, k_recv) =
                        conn.open_bi().await.map_err(|e| format!("open-bi K: {e:?}"))?;
                    k_send
                        .write(vec![b'K'])
                        .await
                        .map_err(|e| format!("tag K: {e:?}"))?;
                    Ok::<_, String>((
                        conn,
                        (s_send, s_recv, Vec::new()),
                        (k_send, k_recv, Vec::new()),
                    ))
                } else {
                    let conn = endpoint.accept().await.map_err(|e| format!("accept: {e:?}"))?;
                    let mut s_stream = None;
                    let mut k_stream = None;
                    for _ in 0..2 {
                        let (send, recv) = conn
                            .accept_bi()
                            .await
                            .map_err(|e| format!("accept-bi: {e:?}"))?;
                        let first = recv
                            .read(64 * 1024)
                            .await
                            .map_err(|e| format!("read tag: {e:?}"))?
                            .ok_or("stream closed before tag".to_string())?;
                        let (tag, seed) = (first[0], first[1..].to_vec());
                        match tag {
                            b'S' => s_stream = Some((send, recv, seed)),
                            b'K' => k_stream = Some((send, recv, seed)),
                            other => return Err(format!("unknown stream tag {other}")),
                        }
                    }
                    Ok((
                        conn,
                        s_stream.ok_or("no S stream".to_string())?,
                        k_stream.ok_or("no K stream".to_string())?,
                    ))
                }
            }
            .await;
            let (conn, (s_send, s_recv, s_seed), (k_send, k_recv, k_seed)) = match wire {
                Ok(t) => t,
                Err(e) => {
                    let _ = with_state(|s| s.conn_results.insert(id, Err(e)));
                    return;
                }
            };

            let transport = QueueTransport::new(id);
            wit_bindgen::spawn_local(iroh_writer(transport.out_rx.clone(), s_send));
            wit_bindgen::spawn_local(iroh_reader(transport.in_tx.clone(), s_recv, s_seed));
            let _ = with_state(|s| s.iroh_conns.insert(id, Rc::new(conn)));

            let outcome = subduction_handshake(
                transport,
                initiator,
                expected_peer,
                sd,
                signer,
                my_peer,
                nonce_cache,
            )
            .await;

            if let Ok(peer_hex) = &outcome {
                match hex::decode(peer_hex)
                    .ok()
                    .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
                {
                    Some(peer32) => {
                        let (kh_out_tx, kh_out_rx) = async_channel::unbounded();
                        let (kh_in_tx, kh_in_rx) = async_channel::unbounded();
                        wit_bindgen::spawn_local(iroh_writer(kh_out_rx, k_send));
                        wit_bindgen::spawn_local(iroh_reader(kh_in_tx, k_recv, k_seed));
                        let kh_peer = KeyhivePeerId::from_bytes(peer32);
                        let kh_wire = KhWire {
                            peer: kh_peer.clone(),
                            out_tx: kh_out_tx,
                            in_rx: kh_in_rx,
                        };
                        proto.add_peer(kh_peer.clone(), kh_wire.clone()).await;
                        let recv_proto = proto.clone();
                        let recv_wire = kh_wire.clone();
                        let recv_peer = kh_peer.clone();
                        wit_bindgen::spawn_local(async move {
                            while let Ok(msg) = recv_wire.recv().await {
                                // Spike posture: a failed round is dropped,
                                // not fatal — but say so on stderr.
                                if let Err(e) = recv_proto
                                    .handle_message(&recv_peer, msg, Some(recv_wire.clone()))
                                    .await
                                {
                                    eprintln!("[kh recv] handle_message error: {e:?}");
                                }
                            }
                        });
                        let _ = refreshed_sync(&proto, Some(&kh_peer)).await;
                    }
                    None => {
                        let _ = with_state(|s| {
                            s.conn_results
                                .insert(id, Err("bad peer id from handshake".into()))
                        });
                        return;
                    }
                }
            }
            let _ = with_state(|s| s.conn_results.insert(id, outcome));
        });

        Ok(id)
    }

    async fn conn_status(conn: u32) -> Result<Option<String>, String> {
        breathe().await;
        match with_state(|s| s.conn_results.get(&conn).cloned())? {
            Some(Ok(peer)) => Ok(Some(peer)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    async fn sync_start(peer: Vec<u8>, tree: Vec<u8>, subscribe: bool) -> Result<u32, String> {
        let peer = PeerId::new(arr32(&peer, "peer")?);
        let id = tree_id(&tree)?;
        let (handle, sd) = with_state(|s| {
            let h = s.next_id;
            s.next_id += 1;
            (h, s.sd.clone())
        })?;
        wit_bindgen::spawn_local(async move {
            let outcome = match sd
                .sync_with_peer(&peer, id, subscribe, CallTimeout::Default)
                .await
            {
                Ok((success, stats, errors)) => Ok(format!(
                    "success={success} stats={stats:?} errors={}",
                    errors.len()
                )),
                Err(e) => Err(format!("sync_with_peer: {e:?}")),
            };
            let _ = with_state(|s| s.syncs.insert(handle, outcome));
        });
        Ok(handle)
    }

    async fn sync_status(handle: u32) -> Result<Option<String>, String> {
        breathe().await;
        match with_state(|s| s.syncs.get(&handle).cloned())? {
            Some(Ok(summary)) => Ok(Some(summary)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    async fn create_partition() -> Result<Vec<u8>, String> {
        let kh = with_state(|s| s.kh.clone())?;

        let mut am = AutoCommit::new();
        am.put_object(ROOT, "todos", ObjType::Map)
            .map_err(|e| format!("automerge init: {e}"))?;
        am.commit();
        let change = am
            .get_last_local_change()
            .ok_or("creation produced no change")?;
        let cref = change.hash().0;
        let chunk = change.raw_bytes().to_vec();

        let doc = kh
            .generate_doc(vec![], nonempty::nonempty![cref])
            .await
            .map_err(|e| format!("generate doc: {e:?}"))?;
        let id = { doc.lock().await.doc_id().as_slice().to_vec() };

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
                },
            );
            s.pending.insert(id.clone(), (chunk, cref));
        })?;
        Ok(id)
    }

    async fn seal_partition(id: Vec<u8>) -> Result<(), String> {
        let (chunk, cref) =
            with_state(|s| s.pending.remove(&id))?.ok_or("no pending creation chunk")?;
        encrypt_and_commit(&id, chunk, vec![], cref).await?;
        with_state(|s| s.active = Some(id))?;
        Ok(())
    }

    async fn adopt_partition(id: Vec<u8>) -> Result<(), String> {
        with_state(|s| {
            s.partitions.insert(
                id.clone(),
                Partition {
                    am: AutoCommit::new(),
                    applied: HashSet::new(),
                    revision: 0,
                    undecryptable: 0,
                },
            );
            s.active = Some(id);
        })?;
        Ok(())
    }

    async fn chunk_stats(id: Vec<u8>) -> Result<(u32, u32), String> {
        let sd = with_state(|s| s.sd.clone())?;
        let tree = tree_id(&id)?;
        let commits = sd.get_commits(tree).await.unwrap_or_default();
        let chunks = commits.len() as u32;
        let max_parents = commits
            .iter()
            .map(|c| c.parents().len() as u32)
            .max()
            .unwrap_or(0);
        Ok((chunks, max_parents))
    }

    async fn stats() -> String {
        with_state(|s| {
            let (rev, undec) = s
                .active
                .as_ref()
                .and_then(|id| s.partitions.get(id))
                .map(|p| (p.revision, p.undecryptable))
                .unwrap_or((0, 0));
            format!(
                "webcrypto sign calls: {}; iroh conns: {}; revision: {rev}; undecryptable: {undec}",
                s.signer.0.sign_count.get(),
                s.iroh_conns.len(),
            )
        })
        .unwrap_or_else(|e| e)
    }
}

// --- the tasks data service (served from inside the engine composite) ---

impl TasksGuest for Component {
    async fn partition() -> Result<Vec<u8>, String> {
        active_partition()
    }

    async fn revision() -> Result<u64, String> {
        let id = active_partition()?;
        apply_new_chunks(&id).await?;
        with_state(|s| s.partitions.get(&id).map(|p| p.revision))?.ok_or("unknown partition".into())
    }

    async fn items() -> Result<Snapshot, String> {
        let id = active_partition()?;
        apply_new_chunks(&id).await?;
        with_state(|s| -> Result<Snapshot, String> {
            let p = s.partitions.get(&id).ok_or("unknown partition")?;
            Ok(Snapshot {
                revision: p.revision,
                items: read_snapshot(&p.am)?,
            })
        })?
    }

    async fn add(title: String) -> Result<String, String> {
        let id = active_partition()?;
        author(&id, |am| {
            let todos = todos_object(am)?;
            let item_id = hex::encode(rand::random::<[u8; 8]>());
            let item = am
                .put_object(&todos, &item_id, ObjType::Map)
                .map_err(|e| format!("put item: {e}"))?;
            am.put(&item, "title", title.as_str())
                .map_err(|e| format!("put title: {e}"))?;
            am.put(&item, "completed", false)
                .map_err(|e| format!("put completed: {e}"))?;
            Ok(item_id)
        })
        .await
    }

    async fn set_completed(item: String, completed: bool) -> Result<(), String> {
        let id = active_partition()?;
        author(&id, |am| {
            let todos = todos_object(am)?;
            let Some((Value::Object(_), obj)) =
                am.get(&todos, &item).map_err(|e| e.to_string())?
            else {
                return Err(format!("no item {item}"));
            };
            am.put(&obj, "completed", completed)
                .map_err(|e| format!("put completed: {e}"))?;
            Ok(())
        })
        .await
    }

    async fn set_title(item: String, title: String) -> Result<(), String> {
        let id = active_partition()?;
        author(&id, |am| {
            let todos = todos_object(am)?;
            let Some((Value::Object(_), obj)) =
                am.get(&todos, &item).map_err(|e| e.to_string())?
            else {
                return Err(format!("no item {item}"));
            };
            am.put(&obj, "title", title.as_str())
                .map_err(|e| format!("put title: {e}"))?;
            Ok(())
        })
        .await
    }

    async fn remove(item: String) -> Result<(), String> {
        let id = active_partition()?;
        author(&id, |am| {
            let todos = todos_object(am)?;
            am.delete(&todos, &item)
                .map_err(|e| format!("delete: {e}"))?;
            Ok(())
        })
        .await
    }
}

export!(Component);
