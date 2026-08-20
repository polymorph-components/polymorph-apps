//! S3 storage-provider config panel (#19 x #22): a sandboxed APP, never
//! the visor. Deliberately PURE — the `s3-panel` world imports only
//! dom/events/shell, no network capability at all (the #21
//! capability-profile contrast against its dropbox sibling).
//!
//! Protocol (todomvc.wit:174-177): the visor calls `seed(config-json)` then
//! `run()`; pumps `on-event`; polls `outcome()` after each event.
//! `outcome` is none while the session is live, some("") for cancelled,
//! some(json) for completed.

use std::cell::RefCell;

// The generated bindings occasionally exceed clippy's default arg-count
// threshold; that's a wit-bindgen codegen property, not something this
// crate's code controls.
#[allow(clippy::too_many_arguments)]
mod bindings {
    wit_bindgen::generate!({
        path: "../wit",
        world: "s3-panel",
        generate_all,
    });
}
use bindings::*;

use crate::polymorph::todomvc_spike::dom::{create_element, Element};
use crate::polymorph::todomvc_spike::events::{listen, EventKind};
use crate::polymorph::todomvc_spike::shell;

use serde::{Deserialize, Serialize};

const TOK_ENDPOINT: u32 = 1;
const TOK_BUCKET: u32 = 2;
// No credential tokens: the access key and secret key are THE VISOR's
// fields now (#22, `credential-needs` below). Secrets must never be
// typed into component-drawn pixels, so this panel has no input for
// them and never learns their values.
// No save/cancel tokens either: those affordances are THE VISOR's, rendered
// outside this granted region (#22 — a panel that owns its own Save
// button owns the user's sense of what saving means).

#[derive(Default, Deserialize, Serialize)]
struct Seed {
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    bucket: String,
}

#[derive(Serialize)]
struct SaveOutcome<'a> {
    provider: &'static str,
    endpoint: &'a str,
    bucket: &'a str,
}

struct App {
    seed: Seed,
    endpoint: String,
    bucket: String,
    /// Where the panel explains a refused commit, inside its own region.
    status: Option<Element>,
}

thread_local! {
    static APP: RefCell<App> = RefCell::new(App {
        seed: Seed::default(),
        endpoint: String::new(),
        bucket: String::new(),
        status: None,
    });
}

// --- view -----------------------------------------------------------------

fn el(tag: &str, class: &str) -> Element {
    let e = create_element(tag);
    if !class.is_empty() {
        e.set_attribute("class", class);
    }
    e
}

/// Build one labeled text input row. `input type` is validated against
/// {"text", "checkbox"} only (spikes/todomvc/host/validate.ts). Nothing
/// secret is ever typed here: this panel only draws the PUBLIC parts of
/// the configuration (endpoint, bucket).
fn field(root: &Element, label_text: &str, placeholder: &str, token: u32) -> Element {
    let row = el("div", "field");
    let label = el("label", "");
    label.set_text_content(label_text);
    let input = el("input", "");
    input.set_attribute("type", "text");
    input.set_attribute("placeholder", placeholder);
    listen(&input, EventKind::Input, token);
    row.append_child(&label);
    row.append_child(&input);
    root.append_child(&row);
    input
}

fn build(app: &mut App) {
    let root = shell::root();
    let panel = el("section", "panel-s3");

    let h1 = el("h1", "");
    h1.set_text_content("Connect S3-compatible storage");
    panel.append_child(&h1);

    let hint = el("div", "hint");
    hint.set_text_content("pure component: this panel cannot reach the network");
    panel.append_child(&hint);

    let endpoint = field(&panel, "Endpoint", "https://s3.example.com", TOK_ENDPOINT);
    let bucket = field(&panel, "Bucket", "my-bucket", TOK_BUCKET);
    // The credential fields live in THE VISOR, below this region: the panel
    // declares the KINDS it needs (see `credential_needs`) and the visor
    // renders them with its own labels.
    let creds = el("div", "hint");
    creds.set_text_content(
        "credentials are entered in the visor fields below — this panel never sees them",
    );
    panel.append_child(&creds);

    endpoint.set_value(&app.seed.endpoint);
    bucket.set_value(&app.seed.bucket);
    app.endpoint = app.seed.endpoint.clone();
    app.bucket = app.seed.bucket.clone();

    let status = el("div", "status");
    panel.append_child(&status);
    app.status = Some(status);

    root.append_child(&panel);
}

/// The visor asks for the configuration when the user presses ITS Save.
/// `None` means "not valid yet" — the panel says why in its own region.
fn commit_config(app: &mut App) -> Option<String> {
    let endpoint = app.endpoint.trim_end_matches('/').to_string();
    let bucket = app.bucket.trim().to_string();
    if endpoint.is_empty() || bucket.is_empty() {
        if let Some(status) = &app.status {
            status.set_text_content("endpoint and bucket are required");
        }
        return None;
    }
    if let Some(status) = &app.status {
        status.set_text_content("");
    }
    let out = SaveOutcome {
        provider: "s3",
        endpoint: &endpoint,
        bucket: &bucket,
    };
    Some(serde_json::to_string(&out).expect("serialize outcome"))
}

/// Best-effort "origin" of the endpoint field: trim, drop any path, and
/// lowercase the scheme+authority. Plain string manipulation is enough
/// here — the visor re-normalizes with `new URL()` and compares origins
/// itself, so a sloppy answer costs the panel its binding, not the visor
/// its enforcement. "" when there is nothing to report.
fn origin_of(endpoint: &str) -> String {
    let raw = endpoint.trim().trim_end_matches('/');
    if raw.is_empty() {
        return String::new();
    }
    let (scheme, rest) = match raw.split_once("://") {
        Some((s, r)) => (s, r),
        // No scheme: the visor cannot parse it either, so report nothing
        // rather than inventing one.
        None => return String::new(),
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return String::new();
    }
    format!("{}://{}", scheme.to_lowercase(), authority.to_lowercase())
}

fn handle_event(app: &mut App, ev: Event) {
    match ev.token {
        TOK_ENDPOINT => app.endpoint = ev.value.unwrap_or_default(),
        TOK_BUCKET => app.bucket = ev.value.unwrap_or_default(),
        _ => {}
    }
}

// --- component exports ------------------------------------------------------

struct Component;

impl Guest for Component {
    async fn seed(config: String) {
        let seed: Seed = if config.trim().is_empty() {
            Seed::default()
        } else {
            serde_json::from_str(&config).unwrap_or_default()
        };
        APP.with(|a| a.borrow_mut().seed = seed);
    }

    async fn run() {
        APP.with(|a| build(&mut a.borrow_mut()));
    }

    async fn on_event(ev: Event) {
        APP.with(|a| handle_event(&mut a.borrow_mut(), ev));
    }

    /// The visor drives completion now; the panel never sets an outcome.
    async fn outcome() -> Option<String> {
        None
    }

    async fn commit() -> Option<String> {
        APP.with(|a| commit_config(&mut a.borrow_mut()))
    }

    /// The credential vocabulary (#22): kinds only, never labels. The visor
    /// renders these fields in its own pixels, outside this region, and
    /// the values never cross back into this component.
    fn credential_needs() -> Vec<CredentialKind> {
        vec![CredentialKind::AccessKey, CredentialKind::SecretKey]
    }

    /// Where this panel's configuration currently points (#22). The visor
    /// re-reads this after every event, shows it, and binds the
    /// credentials it holds to it. Best-effort origin normalization only:
    /// the visor re-parses with its own URL machinery and is the one that
    /// enforces — this string is an INPUT to the visor's normalization,
    /// never a claim the visor trusts as written.
    fn destination() -> String {
        APP.with(|a| origin_of(&a.borrow().endpoint))
    }

    /// What this panel calls itself. SELF-DECLARED, therefore worth
    /// nothing as identity: the visor renders it foreign-quoted and clamped,
    /// keys its trust record on the artifact name it fetched, and lets
    /// the user assign the name they will actually recognise.
    fn nickname() -> String {
        "S3 object storage".to_string()
    }
}

export!(Component);
