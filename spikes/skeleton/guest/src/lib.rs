//! The walking skeleton guest: automerge content end-to-end encrypted
//! under keyhive groups, synced as ciphertext by subduction over a
//! component-iroh QUIC wire — one engine composite, one platform-held
//! identity backing both layers.
//!
//! Composition of the two prior spikes plus the content spine:
//! - keyhive (spike 1): membership, CGKA, encrypt/decrypt; identity via
//!   `polymorph:webcrypto` (`AsyncSigner`).
//! - subduction (spike 2): sedimentree sync over frame queues fed by
//!   iroh stream-pump tasks; the same webcrypto key backs its `Signer`,
//!   so the keyhive individual and the subduction peer are one id.
//! - content: automerge chunks; chunk ref = blake3(plaintext) is both
//!   the keyhive content ref and the sedimentree commit head; the
//!   sedimentree blob is the keyhive `EncryptedContent` envelope.

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
use automerge::{AutoCommit, Automerge, ReadDoc, ROOT};
use ed25519_dalek::VerifyingKey as DalekVerifyingKey;
use future_form::{FutureForm, Local};
use futures::future::{AbortHandle, Abortable, LocalBoxFuture};

use polymorph_webcrypto_guest::{ed25519, SigningKey, SigningKeyOptions};

use beekem::encrypted::EncryptedContent;
use keyhive_core::access::Access;
use keyhive_core::keyhive::Keyhive;
use keyhive_core::listener::no_listener::NoListener;
use keyhive_core::principal::document::id::DocumentId;
use keyhive_core::principal::identifier::Identifier;
use keyhive_core::principal::individual::id::IndividualId;
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

use exports::polymorph::skeleton_spike::driver::{Authored, DocView, Guest};
use polymorph::iroh::endpoint::{Endpoint, EndpointOptions, RecvStream, SendStream};
use polymorph::iroh::identity_generate;
use polymorph::iroh::types::{EndpointAddr, TransportAddr};

/// The iroh ALPN for the skeleton's subduction wire.
const ALPN: &[u8] = b"skeleton-spike/0";

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

// --- one signer, two traits: the same platform-held key backs keyhive and
// --- subduction, so the keyhive individual and the subduction peer are the
// --- same 32 bytes.

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

/// keyhive's signer: fallible.
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

/// subduction's signer: infallible upstream, so a platform failure can only
/// trap (recorded API-fit finding, spike 2).
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

// --- spawn + timeout for the wit-bindgen runtime ---

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

/// Never fires; fine for a spike where every response eventually arrives.
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

/// The keyhive protocol's wire: bincode SignedMessages over frame queues
/// fed by iroh stream pumps (a second stream on the same connection).
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
    /// Author-side automerge docs and each doc's latest content ref.
    docs: HashMap<Vec<u8>, AutoCommit>,
    last_ref: HashMap<Vec<u8>, [u8; 32]>,
    /// Initial chunks awaiting `seal-initial` (created before members join).
    pending: HashMap<Vec<u8>, (Vec<u8>, [u8; 32])>,
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
    let arr = arr32(bytes, "doc id")?;
    let vk = DalekVerifyingKey::from_bytes(&arr).map_err(|e| format!("bad doc id: {e:?}"))?;
    Ok(DocumentId::from(Identifier::from(vk)))
}

fn individual_id(bytes: &[u8]) -> Result<IndividualId, String> {
    let arr = arr32(bytes, "peer id")?;
    let vk = DalekVerifyingKey::from_bytes(&arr).map_err(|e| format!("bad peer id: {e:?}"))?;
    Ok(Identifier::from(vk).into())
}

fn tree_id(bytes: &[u8]) -> Result<SedimentreeId, String> {
    Ok(SedimentreeId::new(arr32(bytes, "tree id")?))
}

async fn breathe() {
    wit_bindgen::yield_async().await;
    wit_bindgen::yield_async().await;
}

// --- shared handshake + iroh pumps (from spike 2) ---

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
    }
}

// --- content helpers ---

/// Encrypt one plaintext chunk for the doc and commit its envelope to the
/// sedimentree. Any CGKA update the encryption produced is synced to peers
/// over the bridge.
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
        proto
            .sync_keyhive(None)
            .await
            .map_err(|e| format!("sync keyhive: {e:?}"))?;
    }
    breathe().await;
    Ok(())
}

/// Causal order for the spike's commit DAGs: parents before children,
/// ties broken by head bytes.
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
            // Missing parents (partial replica): append what remains in
            // head order; their decrypt/apply will report the gap.
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

// --- the exported driver ---

struct Component;

impl Guest for Component {
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
        let proto: Rc<KhProto> = Rc::new(KeyhiveProtocol::new(
            Arc::new(async_lock::Mutex::new(kh.clone())),
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
                docs: HashMap::new(),
                last_ref: HashMap::new(),
                pending: HashMap::new(),
                next_id: 0,
            })
        });
        Ok(hex::encode(verifying.to_bytes()))
    }

    // --- keyhive membership (synced by the bridge over the wire) ---

    async fn kh_knows_peer(peer: Vec<u8>) -> Result<bool, String> {
        breathe().await;
        let kh = with_state(|s| s.kh.clone())?;
        let iid = individual_id(&peer)?;
        Ok(kh.get_agent(iid.into()).await.is_some())
    }

    async fn kh_add_member(doc_id: Vec<u8>, peer: Vec<u8>) -> Result<(), String> {
        let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
        let did = kh_doc_id(&doc_id)?;
        let iid = individual_id(&peer)?;
        let agent = kh
            .get_agent(iid.into())
            .await
            .ok_or("agent not found (bridge has not synced its contact card yet)".to_string())?;
        let doc = kh
            .get_document(did)
            .await
            .ok_or("doc not found".to_string())?;
        kh.add_member(agent, &Membered::Document(did, doc), Access::Read, &[])
            .await
            .map_err(|e| format!("add member: {e:?}"))?;
        proto
            .sync_keyhive(None)
            .await
            .map_err(|e| format!("sync keyhive: {e:?}"))?;
        Ok(())
    }

    async fn kh_revoke_member(doc_id: Vec<u8>, peer: Vec<u8>) -> Result<(), String> {
        let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
        let did = kh_doc_id(&doc_id)?;
        let iid = individual_id(&peer)?;
        let doc = kh
            .get_document(did)
            .await
            .ok_or("doc not found".to_string())?;
        kh.revoke_member(iid.into(), true, &Membered::Document(did, doc))
            .await
            .map_err(|e| format!("revoke member: {e:?}"))?;
        proto
            .sync_keyhive(None)
            .await
            .map_err(|e| format!("sync keyhive: {e:?}"))?;
        Ok(())
    }

    // --- the iroh wire (spike 2) ---

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
            // Establish the connection and two streams: 'S' carries the
            // subduction frames, 'K' the keyhive bridge protocol. The
            // initiator opens and tags both; the acceptor classifies by
            // the first byte (which may arrive coalesced with frames).
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
                    Ok::<_, String>((conn, (s_send, s_recv, Vec::new()), (k_send, k_recv, Vec::new())))
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

            // The subduction handshake authenticated the peer; the keyhive
            // bridge runs against the same identity on the K stream.
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
                                // not fatal.
                                let _ = recv_proto
                                    .handle_message(&recv_peer, msg, Some(recv_wire.clone()))
                                    .await;
                            }
                        });
                        let _ = proto.sync_keyhive(Some(&kh_peer)).await;
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

    async fn commits(tree: Vec<u8>) -> Result<Vec<Vec<u8>>, String> {
        let sd = with_state(|s| s.sd.clone())?;
        let id = tree_id(&tree)?;
        let mut heads: Vec<Vec<u8>> = sd
            .get_commits(id)
            .await
            .unwrap_or_default()
            .iter()
            .map(|c| c.head().as_bytes().to_vec())
            .collect();
        heads.sort();
        Ok(heads)
    }

    // --- the content spine ---

    async fn create_shared(initial_text: String) -> Result<Authored, String> {
        let kh = with_state(|s| s.kh.clone())?;

        let mut am = AutoCommit::new();
        am.put(ROOT, "msg", initial_text)
            .map_err(|e| format!("automerge put: {e}"))?;
        let chunk = am.save();
        let cref: [u8; 32] = blake3::hash(&chunk).into();

        let doc = kh
            .generate_doc(vec![], nonempty::nonempty![cref])
            .await
            .map_err(|e| format!("generate doc: {e:?}"))?;
        let id = { doc.lock().await.doc_id().as_slice().to_vec() };

        with_state(|s| {
            s.docs.insert(id.clone(), am);
            s.last_ref.insert(id.clone(), cref);
            s.pending.insert(id.clone(), (chunk, cref));
        })?;
        Ok(Authored {
            id,
            content_ref: cref.to_vec(),
        })
    }

    async fn seal_initial(id: Vec<u8>) -> Result<Authored, String> {
        let (chunk, cref) =
            with_state(|s| s.pending.remove(&id))?.ok_or("no pending initial chunk")?;
        encrypt_and_commit(&id, chunk, vec![], cref).await?;
        Ok(Authored {
            id,
            content_ref: cref.to_vec(),
        })
    }

    async fn author_change(id: Vec<u8>, text: String) -> Result<Authored, String> {
        let mut am = with_state(|s| s.docs.remove(&id))?.ok_or("not the author of this doc")?;
        let pred = with_state(|s| s.last_ref.get(&id).copied())?.ok_or("no previous ref")?;

        am.put(ROOT, "msg", text)
            .map_err(|e| format!("automerge put: {e}"))?;
        let chunk = am.save_incremental();
        let cref: [u8; 32] = blake3::hash(&chunk).into();

        encrypt_and_commit(&id, chunk, vec![pred], cref).await?;
        with_state(|s| {
            s.docs.insert(id.clone(), am);
            s.last_ref.insert(id.clone(), cref);
        })?;
        Ok(Authored {
            id,
            content_ref: cref.to_vec(),
        })
    }

    async fn read_doc(id: Vec<u8>) -> Result<DocView, String> {
        let (kh, sd, storage) = with_state(|s| (s.kh.clone(), s.sd.clone(), s.sd_storage.clone()))?;
        let tree = tree_id(&id)?;
        let did = kh_doc_id(&id)?;
        let kh_doc = kh
            .get_document(did)
            .await
            .ok_or("keyhive doc not found".to_string())?;

        let commits = sd.get_commits(tree).await.unwrap_or_default();
        let ordered = causal_order(commits);

        let mut doc: Option<Automerge> = None;
        let mut chunks_read = 0u32;
        let mut chunks_failed = 0u32;
        let mut last_error = None;

        for commit in ordered {
            let verified = <MemoryStorage as Storage<Local>>::load_loose_commit(
                &storage,
                tree,
                commit.head(),
            )
            .await
            .map_err(|e| format!("load: {e:?}"))?
            .ok_or("commit blob not found")?;
            let envelope: EncryptedContent<P, T> =
                bincode::deserialize(verified.blob().as_slice())
                    .map_err(|e| format!("bad envelope: {e}"))?;
            match kh.try_decrypt_content(kh_doc.clone(), &envelope).await {
                Ok(plain) => {
                    chunks_read += 1;
                    match &mut doc {
                        None => {
                            doc = Some(
                                Automerge::load(&plain)
                                    .map_err(|e| format!("automerge load: {e}"))?,
                            )
                        }
                        Some(d) => {
                            d.load_incremental(&plain)
                                .map_err(|e| format!("automerge apply: {e}"))?;
                        }
                    }
                }
                Err(e) => {
                    chunks_failed += 1;
                    last_error = Some(format!("{e:?}"));
                }
            }
        }

        let text = match &doc {
            Some(d) => match d.get(ROOT, "msg").map_err(|e| format!("get: {e}"))? {
                Some((value, _)) => value
                    .into_string()
                    .unwrap_or_else(|v| format!("<non-string: {v:?}>")),
                None => String::new(),
            },
            None => String::new(),
        };

        Ok(DocView {
            text,
            chunks_read,
            chunks_failed,
            last_error,
        })
    }

    async fn stats() -> String {
        with_state(|s| {
            format!(
                "webcrypto sign calls: {}; iroh conns: {}; authored docs: {}",
                s.signer.0.sign_count.get(),
                s.iroh_conns.len(),
                s.docs.len()
            )
        })
        .unwrap_or_else(|e| e)
    }
}

export!(Component);
