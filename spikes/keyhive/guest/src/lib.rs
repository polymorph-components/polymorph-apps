//! Spike guest: `keyhive_core` embedded in a wasm32-wasip2 component, with
//! identity signing routed through `polymorph:webcrypto` — the signing key
//! is a non-extractable platform handle; the secret never enters guest
//! linear memory. One keyhive instance per component instance; the host
//! shuttles opaque blobs between two of them (see `wit/spike.wit`).

wit_bindgen::generate!({
    path: "wit",
    world: "spike",
});

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use ed25519_dalek::VerifyingKey as DalekVerifyingKey;
use future_form::Local;
use futures::future::LocalBoxFuture;
use futures::lock::Mutex;

use beekem::encrypted::EncryptedContent;
use keyhive_core::access::Access;
use keyhive_core::archive::Archive;
use keyhive_core::contact_card::ContactCard;
use keyhive_core::event::static_event::StaticEvent;
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
use polymorph_webcrypto_guest::{ed25519, SigningKey, SigningKeyOptions};
use rand::rngs::OsRng;

use exports::polymorph::keyhive_spike::driver::{DocCreated, Encrypted, Guest};

type T = [u8; 32];
type P = Vec<u8>;
type CtStore = MemoryCiphertextStore<T, P>;
type Kh = Keyhive<Local, SpikeSigner, T, P, CtStore, NoListener, OsRng>;

// --- the signer: keyhive's AsyncSigner over the polymorph:webcrypto import ---

struct SignerInner {
    /// The platform-held signing key. Only a handle; `extractable: false`.
    key: SigningKey,
    /// The public half, exported once at generation.
    verifying: DalekVerifyingKey,
    /// Signature calls made across the WIT boundary.
    sign_count: Cell<u64>,
}

/// Clone-able handle (keyhive requires `S: Clone`); `Local` future form, so
/// `Rc` suffices.
#[derive(Clone)]
struct SpikeSigner(Rc<SignerInner>);

impl std::fmt::Debug for SpikeSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpikeSigner")
            .field("verifying", &hex::encode(self.0.verifying.to_bytes()))
            .finish()
    }
}

impl Verifiable for SpikeSigner {
    fn verifying_key(&self) -> DalekVerifyingKey {
        self.0.verifying
    }
}

impl AsyncSigner<Local> for SpikeSigner {
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

// --- instance state ---

struct State {
    kh: Kh,
    signer: SpikeSigner,
    /// peer id bytes -> IndividualId, learned from contact cards.
    peers: HashMap<Vec<u8>, IndividualId>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// Run `f` under a short-lived borrow of the state. Never hold the borrow
/// across an await: clone the (Arc-backed) keyhive handle out instead.
fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> Result<R, String> {
    STATE.with(|s| {
        s.borrow_mut()
            .as_mut()
            .map(f)
            .ok_or_else(|| "not initialized (call init first)".to_string())
    })
}

fn kh() -> Result<Kh, String> {
    with_state(|s| s.kh.clone())
}

fn doc_id_from_bytes(bytes: &[u8]) -> Result<DocumentId, String> {
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "doc id must be 32 bytes".to_string())?;
    let vk = DalekVerifyingKey::from_bytes(&arr).map_err(|e| format!("bad doc id: {e:?}"))?;
    Ok(DocumentId::from(Identifier::from(vk)))
}

fn peer_id(bytes: &[u8]) -> Result<IndividualId, String> {
    with_state(|s| s.peers.get(bytes).copied())?
        .ok_or_else(|| "unknown peer (receive its contact card first)".to_string())
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
        let arr: [u8; 32] = vk_raw
            .as_slice()
            .try_into()
            .map_err(|_| "verifying key is not 32 bytes".to_string())?;
        let verifying =
            DalekVerifyingKey::from_bytes(&arr).map_err(|e| format!("parse verifying key: {e:?}"))?;

        let signer = SpikeSigner(Rc::new(SignerInner {
            key,
            verifying,
            sign_count: Cell::new(0),
        }));

        let kh = Kh::generate(signer.clone(), MemoryCiphertextStore::new(), NoListener, OsRng)
            .await
            .map_err(|e| format!("keyhive generate: {e:?}"))?;

        let id_hex = hex::encode(verifying.to_bytes());
        STATE.with(|s| {
            *s.borrow_mut() = Some(State {
                kh,
                signer,
                peers: HashMap::new(),
            })
        });
        Ok(id_hex)
    }

    async fn contact_card() -> Result<Vec<u8>, String> {
        let kh = kh()?;
        let card = kh
            .contact_card()
            .await
            .map_err(|e| format!("contact card: {e:?}"))?;
        bincode::serialize(&card).map_err(|e| format!("serialize contact card: {e}"))
    }

    async fn receive_contact_card(card: Vec<u8>) -> Result<String, String> {
        let kh = kh()?;
        let card: ContactCard =
            bincode::deserialize(&card).map_err(|e| format!("bad contact card: {e}"))?;
        kh.receive_contact_card(&card)
            .await
            .map_err(|e| format!("receive contact card: {e:?}"))?;
        let id = card.id();
        with_state(|s| s.peers.insert(id.as_slice().to_vec(), id))?;
        Ok(hex::encode(id.as_slice()))
    }

    async fn create_doc(initial_content: Vec<u8>) -> Result<DocCreated, String> {
        let kh = kh()?;
        let head: [u8; 32] = blake3::hash(&initial_content).into();
        let doc = kh
            .generate_doc(vec![], nonempty::nonempty![head])
            .await
            .map_err(|e| format!("generate doc: {e:?}"))?;
        let doc_id = { doc.lock().await.doc_id() };
        Ok(DocCreated {
            doc_id: doc_id.as_slice().to_vec(),
            content_ref: head.to_vec(),
        })
    }

    async fn add_member(doc_id: Vec<u8>, peer: Vec<u8>) -> Result<(), String> {
        let kh = kh()?;
        let did = doc_id_from_bytes(&doc_id)?;
        let iid = peer_id(&peer)?;
        let agent = kh
            .get_agent(iid.into())
            .await
            .ok_or("agent not found".to_string())?;
        let doc = kh
            .get_document(did)
            .await
            .ok_or("doc not found".to_string())?;
        kh.add_member(agent, &Membered::Document(did, doc), Access::Read, &[])
            .await
            .map_err(|e| format!("add member: {e:?}"))?;
        Ok(())
    }

    async fn revoke_member(doc_id: Vec<u8>, peer: Vec<u8>) -> Result<(), String> {
        let kh = kh()?;
        let did = doc_id_from_bytes(&doc_id)?;
        let iid = peer_id(&peer)?;
        let doc = kh
            .get_document(did)
            .await
            .ok_or("doc not found".to_string())?;
        kh.revoke_member(iid.into(), true, &Membered::Document(did, doc))
            .await
            .map_err(|e| format!("revoke member: {e:?}"))?;
        Ok(())
    }

    async fn events_for_peer(peer: Vec<u8>) -> Result<Vec<u8>, String> {
        let kh = kh()?;
        let iid = peer_id(&peer)?;
        let agent = kh
            .get_agent(iid.into())
            .await
            .ok_or("agent not found".to_string())?;
        let events = kh.static_events_for_agent(&agent).await;
        let events: Vec<StaticEvent<T>> = events.into_values().collect();
        bincode::serialize(&events).map_err(|e| format!("serialize events: {e}"))
    }

    async fn ingest_events(events: Vec<u8>) -> Result<u32, String> {
        let kh = kh()?;
        let events: Vec<StaticEvent<T>> =
            bincode::deserialize(&events).map_err(|e| format!("bad events: {e}"))?;
        let stuck = kh.ingest_unsorted_static_events(events).await;
        Ok(stuck.len() as u32)
    }

    async fn encrypt(doc_id: Vec<u8>, content: Vec<u8>, pred_ref: Vec<u8>) -> Result<Encrypted, String> {
        let kh = kh()?;
        let did = doc_id_from_bytes(&doc_id)?;
        let doc = kh
            .get_document(did)
            .await
            .ok_or("doc not found".to_string())?;
        let content_ref: [u8; 32] = blake3::hash(&content).into();
        let preds: Vec<T> = if pred_ref.is_empty() {
            vec![]
        } else {
            vec![pred_ref
                .as_slice()
                .try_into()
                .map_err(|_| "pred ref must be 32 bytes".to_string())?]
        };
        let out = kh
            .try_encrypt_content(doc, &content_ref, &preds, &content)
            .await
            .map_err(|e| format!("encrypt: {e:?}"))?;
        let ciphertext =
            bincode::serialize(out.encrypted_content()).map_err(|e| format!("serialize: {e}"))?;
        let update_events = match out.update_op() {
            Some(op) => {
                let events: Vec<StaticEvent<T>> = vec![StaticEvent::from(Box::new(op.clone()))];
                Some(bincode::serialize(&events).map_err(|e| format!("serialize update: {e}"))?)
            }
            None => None,
        };
        Ok(Encrypted {
            content_ref: content_ref.to_vec(),
            ciphertext,
            update_events,
        })
    }

    async fn decrypt(doc_id: Vec<u8>, ciphertext: Vec<u8>) -> Result<Vec<u8>, String> {
        let kh = kh()?;
        let did = doc_id_from_bytes(&doc_id)?;
        let doc = kh
            .get_document(did)
            .await
            .ok_or("doc not found".to_string())?;
        let encrypted: EncryptedContent<P, T> =
            bincode::deserialize(&ciphertext).map_err(|e| format!("bad ciphertext: {e}"))?;
        kh.try_decrypt_content(doc, &encrypted)
            .await
            .map_err(|e| format!("decrypt: {e:?}"))
    }

    async fn archive_roundtrip() -> Result<String, String> {
        let (kh0, signer) = with_state(|s| (s.kh.clone(), s.signer.clone()))?;
        let archive = kh0.into_archive().await;
        let bytes = bincode::serialize(&archive).map_err(|e| format!("serialize archive: {e}"))?;
        let parsed: Archive<T> =
            bincode::deserialize(&bytes).map_err(|e| format!("parse archive: {e}"))?;
        let restored = Kh::try_from_archive(
            &parsed,
            signer,
            MemoryCiphertextStore::new(),
            NoListener,
            Arc::new(Mutex::new(OsRng)),
        )
        .await
        .map_err(|e| format!("restore: {e:?}"))?;
        with_state(|s| s.kh = restored)?;
        Ok(format!(
            "archive {} bytes; restored with the same platform-held signer and swapped in",
            bytes.len()
        ))
    }

    async fn stats() -> String {
        with_state(|s| {
            format!(
                "webcrypto sign calls: {}; known peers: {}",
                s.signer.0.sign_count.get(),
                s.peers.len()
            )
        })
        .unwrap_or_else(|e| e)
    }
}

export!(Component);
