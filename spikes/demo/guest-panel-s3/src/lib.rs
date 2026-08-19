//! S3 storage-provider config panel (#19 x #22): a sandboxed APP, never
//! chrome. Deliberately PURE — the `s3-panel` world imports only
//! dom/events/shell, no network capability at all (the #21
//! capability-profile contrast against its dropbox sibling).
//!
//! Protocol (todomvc.wit:174-177): chrome calls `seed(config-json)` then
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
const TOK_ACCESS: u32 = 3;
const TOK_SECRET: u32 = 4;
// No save/cancel tokens: those affordances are CHROME's, rendered
// outside this granted region (#22 — a panel that owns its own Save
// button owns the user's sense of what saving means).

#[derive(Default, Deserialize, Serialize)]
struct Seed {
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    bucket: String,
    #[serde(default)]
    access: String,
    #[serde(default)]
    secret: String,
}

#[derive(Serialize)]
struct SaveOutcome<'a> {
    provider: &'static str,
    endpoint: &'a str,
    bucket: &'a str,
    access: &'a str,
    secret: &'a str,
}

struct App {
    seed: Seed,
    endpoint: String,
    bucket: String,
    access: String,
    secret: String,
    /// Where the panel explains a refused commit, inside its own region.
    status: Option<Element>,
}

thread_local! {
    static APP: RefCell<App> = RefCell::new(App {
        seed: Seed::default(),
        endpoint: String::new(),
        bucket: String::new(),
        access: String::new(),
        secret: String::new(),
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
/// {"text", "checkbox"} only (spikes/todomvc/host/validate.ts) — there is
/// no `password` type on this surface, so the secret-key field is a plain
/// text input (noted at the call site).
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
    let access = field(&panel, "Access key", "", TOK_ACCESS);
    // Secret key: plain text input, not `type=password` — the surface
    // allowlist admits only "text"/"checkbox" (validate.ts checkAttr).
    let secret = field(&panel, "Secret key", "", TOK_SECRET);

    endpoint.set_value(&app.seed.endpoint);
    bucket.set_value(&app.seed.bucket);
    access.set_value(&app.seed.access);
    secret.set_value(&app.seed.secret);
    app.endpoint = app.seed.endpoint.clone();
    app.bucket = app.seed.bucket.clone();
    app.access = app.seed.access.clone();
    app.secret = app.seed.secret.clone();

    let status = el("div", "status");
    panel.append_child(&status);
    app.status = Some(status);

    root.append_child(&panel);
}

/// Chrome asks for the configuration when the user presses ITS Save.
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
        access: &app.access,
        secret: &app.secret,
    };
    Some(serde_json::to_string(&out).expect("serialize outcome"))
}

fn handle_event(app: &mut App, ev: Event) {
    match ev.token {
        TOK_ENDPOINT => app.endpoint = ev.value.unwrap_or_default(),
        TOK_BUCKET => app.bucket = ev.value.unwrap_or_default(),
        TOK_ACCESS => app.access = ev.value.unwrap_or_default(),
        TOK_SECRET => app.secret = ev.value.unwrap_or_default(),
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

    /// Chrome drives completion now; the panel never sets an outcome.
    async fn outcome() -> Option<String> {
        None
    }

    async fn commit() -> Option<String> {
        APP.with(|a| commit_config(&mut a.borrow_mut()))
    }
}

export!(Component);
