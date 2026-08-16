//! Spike guest: `subduction_core` embedded in a wasm32-wasip2 component.
//!
//! One subduction peer per component instance: memory storage, open policy,
//! identity signing through `polymorph:webcrypto` (non-extractable platform
//! handle). Connections are "shuttle" transports — frame queues the host
//! drains and delivers between two instances — and the *real* subduction
//! handshake (signed challenge/response) runs over them. Listener, manager,
//! handshake, and sync rounds all run as `wit_bindgen::spawn_local` tasks;
//! exports are short calls that never block on another task.

wit_bindgen::generate!({
    path: "wit",
    world: "spike",
    generate_all,
});

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ed25519_dalek::VerifyingKey as DalekVerifyingKey;
use future_form::{FutureForm, Local};
use futures::future::{AbortHandle, Abortable, LocalBoxFuture};

use polymorph_webcrypto_guest::{ed25519, SigningKey, SigningKeyOptions};
use sedimentree_core::{
    blob::Blob, depth::CountLeadingZeroBytes, id::SedimentreeId, loose_commit::id::CommitId,
};
use subduction_core::{
    handler::sync::SyncHandler,
    handshake::{self, audience::Audience, Handshake},
    nonce_cache::NonceCache,
    peer::id::PeerId,
    policy::open::OpenPolicy,
    spawn::Spawn,
    storage::{memory::MemoryStorage, traits::Storage},
    subduction::{builder::SubductionBuilder, Subduction},
    timeout::{call::CallTimeout, TimedOut, Timeout},
    timestamp::TimestampSeconds,
    transport::{message::MessageTransport, Transport},
};
use subduction_crypto::{nonce::Nonce, signer::Signer};

use exports::polymorph::subduction_spike::driver::Guest;
use polymorph::iroh::endpoint::{Endpoint, EndpointOptions, RecvStream, SendStream};
use polymorph::iroh::identity_generate;
use polymorph::iroh::types::{EndpointAddr, TransportAddr};

/// The iroh ALPN for the spike's subduction wire.
const ALPN: &[u8] = b"subduction-spike/0";

// --- types ---

type Conn = MessageTransport<ShuttleTransport>;
type Hdl = SyncHandler<Local, MemoryStorage, Conn, OpenPolicy, CountLeadingZeroBytes, WitSpawn, 256>;
type Sd = Subduction<
    'static,
    Local,
    MemoryStorage,
    Conn,
    Hdl,
    OpenPolicy,
    WebcryptoSigner,
    NeverTimeout,
    WitSpawn,
    CountLeadingZeroBytes,
    256,
>;

// --- the signer: subduction's Signer over the polymorph:webcrypto import ---

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

impl Signer<Local> for WebcryptoSigner {
    /// Upstream's `Signer::sign` is infallible; a platform signing failure
    /// has nowhere to go but a panic (= component trap). Recorded as an
    /// API-fit finding.
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

/// `Spawn` over `wit_bindgen::spawn_local`: tasks are driven whenever the
/// component has an active export activation.
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

/// A `Timeout` that never fires: the inner future runs to completion. Fine
/// for an in-process spike where every response eventually arrives; a real
/// embedding wants a wasi:clocks-backed timer here.
#[derive(Clone, Debug, PartialEq)]
struct NeverTimeout;

impl Timeout<Local> for NeverTimeout {
    fn timeout<'a, T: 'a>(
        &'a self,
        _dur: Duration,
        fut: <Local as FutureForm>::Future<'a, T>,
    ) -> <Local as FutureForm>::Future<'a, Result<T, TimedOut>> {
        Box::pin(async move { Ok(fut.await) })
    }
}

// --- the shuttle transport ---

#[derive(Debug)]
struct ChannelClosed(&'static str);

impl std::fmt::Display for ChannelClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "shuttle channel closed ({})", self.0)
    }
}

impl std::error::Error for ChannelClosed {}

/// A frame-oriented wire the host pumps: `send_bytes` queues to the outbox
/// (drained by the `outbox` export), `recv_bytes` awaits the inbox (fed by
/// the `deliver` export).
#[derive(Clone, Debug)]
struct ShuttleTransport {
    id: u32,
    out_tx: async_channel::Sender<Vec<u8>>,
    out_rx: async_channel::Receiver<Vec<u8>>,
    in_tx: async_channel::Sender<Vec<u8>>,
    in_rx: async_channel::Receiver<Vec<u8>>,
}

impl PartialEq for ShuttleTransport {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl ShuttleTransport {
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

impl Transport<Local> for ShuttleTransport {
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

/// The same wire, pre-authentication: the handshake sends and receives raw
/// frames, then hands the transport back to become the `Connection`.
struct ShuttleHandshake(ShuttleTransport);

impl Handshake<Local> for ShuttleHandshake {
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
    sd: Arc<Sd>,
    storage: MemoryStorage,
    signer: WebcryptoSigner,
    my_peer: PeerId,
    nonce_cache: Rc<NonceCache>,
    conns: HashMap<u32, ShuttleTransport>,
    conn_results: HashMap<u32, Result<String, String>>,
    syncs: HashMap<u32, Result<String, String>>,
    next_id: u32,
    endpoint: Option<Rc<Endpoint>>,
    iroh_identity: Option<Rc<polymorph::iroh::identity::Identity>>,
    iroh_conns: HashMap<u32, Rc<polymorph::iroh::endpoint::Connection>>,
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

fn tree_id(bytes: &[u8]) -> Result<SedimentreeId, String> {
    Ok(SedimentreeId::new(arr32(bytes, "tree id")?))
}

/// Yield to the wit-bindgen scheduler so spawned tasks can progress.
async fn breathe() {
    wit_bindgen::yield_async().await;
    wit_bindgen::yield_async().await;
}

/// Run the subduction handshake over a queue transport and register the
/// authenticated connection. Shared by the shuttle wire (host pumps the
/// queues) and the iroh wire (stream pump tasks feed the same queues).
#[allow(clippy::too_many_arguments)]
async fn subduction_handshake(
    transport: ShuttleTransport,
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
            ShuttleHandshake(transport),
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
            ShuttleHandshake(transport),
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

/// Pump outbound frames onto the QUIC stream with u32-LE length framing.
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

/// Pump inbound stream bytes into frames (u32-LE length prefix).
async fn iroh_reader(in_tx: async_channel::Sender<Vec<u8>>, recv: RecvStream) {
    let mut buf: Vec<u8> = Vec::new();
    loop {
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

        let storage = MemoryStorage::new();
        let (sd, _handler, listener, manager) = SubductionBuilder::new()
            .signer(signer.clone())
            .storage(storage.clone(), Arc::new(OpenPolicy))
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
                sd,
                storage,
                signer,
                my_peer,
                nonce_cache: Rc::new(NonceCache::default()),
                conns: HashMap::new(),
                conn_results: HashMap::new(),
                syncs: HashMap::new(),
                next_id: 0,
                endpoint: None,
                iroh_identity: None,
                iroh_conns: HashMap::new(),
            })
        });
        Ok(hex::encode(verifying.to_bytes()))
    }

    async fn open_conn(initiator: bool, expected_peer: Vec<u8>) -> Result<u32, String> {
        let (id, transport, sd, signer, my_peer, nonce_cache) = with_state(|s| {
            let id = s.next_id;
            s.next_id += 1;
            let t = ShuttleTransport::new(id);
            s.conns.insert(id, t.clone());
            (
                id,
                t,
                s.sd.clone(),
                s.signer.clone(),
                s.my_peer,
                s.nonce_cache.clone(),
            )
        })?;

        wit_bindgen::spawn_local(async move {
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
            let _ = with_state(|s| s.conn_results.insert(id, outcome));
        });

        Ok(id)
    }

    async fn outbox(conn: u32) -> Result<Vec<Vec<u8>>, String> {
        breathe().await;
        let t = with_state(|s| s.conns.get(&conn).cloned())?.ok_or("unknown conn")?;
        let mut frames = Vec::new();
        while let Ok(frame) = t.out_rx.try_recv() {
            frames.push(frame);
        }
        Ok(frames)
    }

    async fn deliver(conn: u32, frames: Vec<Vec<u8>>) -> Result<(), String> {
        let t = with_state(|s| s.conns.get(&conn).cloned())?.ok_or("unknown conn")?;
        for frame in frames {
            t.in_tx
                .send(frame)
                .await
                .map_err(|_| "inbox closed".to_string())?;
        }
        breathe().await;
        Ok(())
    }

    async fn conn_status(conn: u32) -> Result<Option<String>, String> {
        breathe().await;
        match with_state(|s| s.conn_results.get(&conn).cloned())? {
            Some(Ok(peer)) => Ok(Some(peer)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    async fn add_commit(
        tree: Vec<u8>,
        parents: Vec<Vec<u8>>,
        payload: Vec<u8>,
    ) -> Result<Vec<u8>, String> {
        let sd = with_state(|s| s.sd.clone())?;
        let id = tree_id(&tree)?;
        let head: [u8; 32] = blake3::hash(&payload).into();
        let head = CommitId::new(head);
        let mut parent_set = BTreeSet::new();
        for p in parents {
            parent_set.insert(CommitId::new(arr32(&p, "parent")?));
        }
        let blob = Blob::new(payload);
        sd.add_commit(id, head, parent_set, blob)
            .await
            .map_err(|e| format!("add_commit: {e:?}"))?;
        breathe().await;
        Ok(head.as_bytes().to_vec())
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

    async fn blob_of(tree: Vec<u8>, head: Vec<u8>) -> Result<Vec<u8>, String> {
        let storage = with_state(|s| s.storage.clone())?;
        let id = tree_id(&tree)?;
        let head = CommitId::new(arr32(&head, "head")?);
        let verified = <MemoryStorage as Storage<Local>>::load_loose_commit(&storage, id, head)
            .await
            .map_err(|e| format!("load: {e:?}"))?
            .ok_or("commit not found")?;
        Ok(verified.blob().as_slice().to_vec())
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

        wit_bindgen::spawn_local(async move {
            let wire = if initiator {
                match endpoint
                    .connect(
                        EndpointAddr {
                            endpoint_id: peer_endpoint_id,
                            addrs: vec![TransportAddr::Relay(relay_url)],
                        },
                        ALPN.to_vec(),
                    )
                    .await
                {
                    Ok(conn) => match conn.open_bi().await {
                        Ok((send, recv)) => Ok((conn, send, recv)),
                        Err(e) => Err(format!("open-bi: {e:?}")),
                    },
                    Err(e) => Err(format!("connect: {e:?}")),
                }
            } else {
                match endpoint.accept().await {
                    Ok(conn) => match conn.accept_bi().await {
                        Ok((send, recv)) => Ok((conn, send, recv)),
                        Err(e) => Err(format!("accept-bi: {e:?}")),
                    },
                    Err(e) => Err(format!("accept: {e:?}")),
                }
            };
            let (conn, send, recv) = match wire {
                Ok(t) => t,
                Err(e) => {
                    let _ = with_state(|s| s.conn_results.insert(id, Err(e)));
                    return;
                }
            };

            let transport = ShuttleTransport::new(id);
            wit_bindgen::spawn_local(iroh_writer(transport.out_rx.clone(), send));
            wit_bindgen::spawn_local(iroh_reader(transport.in_tx.clone(), recv));
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
            let _ = with_state(|s| s.conn_results.insert(id, outcome));
        });

        Ok(id)
    }

    async fn stats() -> String {
        with_state(|s| {
            format!(
                "webcrypto sign calls: {}; shuttle conns: {}; iroh conns: {}",
                s.signer.0.sign_count.get(),
                s.conns.len(),
                s.iroh_conns.len()
            )
        })
        .unwrap_or_else(|e| e)
    }
}

export!(Component);
