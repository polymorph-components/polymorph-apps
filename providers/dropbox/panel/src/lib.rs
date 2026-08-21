//! Dropbox storage-provider config panel (#19 x #22): a sandboxed APP,
//! never the visor. Unlike its S3 sibling this panel carries one granted
//! capability: a `fetch` import the visor scopes to `api.dropboxapi.com`.
//! That import itself IS the per-destination network grant (the #21
//! egress-badge story) — this panel cannot reach any other host.
//!
//! It holds NO credential and NO provider-console identifier. App key
//! and app secret moved to the visor's credential drawer with everything
//! else the user pastes out of a provider console: a teachable rule with
//! exceptions is not a teachable rule. What is left here is exactly the
//! provider-specific NON-secret configuration — the root folder — plus
//! a connection test that borrows the visor's injected bearer at the
//! granted boundary. Sign-in is the visor's control now, rendered in the
//! drawer next to the app-key field, so this panel no longer imports
//! the OAuth broker at all (an unused capability is a wrong grant).
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
        path: "../../../wit/todomvc",
        world: "dropbox-panel",
        generate_all,
    });
}
use bindings::*;

use crate::polymorph::fetchspike::fetch;
use crate::polymorph::todomvc_spike::dom::{create_element, Element};
use crate::polymorph::todomvc_spike::events::{listen, EventKind};
use crate::polymorph::todomvc_spike::shell;

use serde::{Deserialize, Serialize};

const TOK_ROOT: u32 = 3;
const TOK_TEST: u32 = 5;
// One field only. Access token, refresh token, app key and app secret
// are all THE VISOR's fields (#22, `credential-needs` below); the root
// folder is the only provider-specific NON-secret configuration this
// panel owns.
// Save/Cancel are THE VISOR's affordances, outside this region (#22), and
// so is "Connect Dropbox (sign-in)" — the ceremony needs the app key,
// which lives in the visor's sheet. "Test connection" stays: it is a
// provider-specific action over this panel's own granted fetch, and it
// carries no credential (the visor injects one at the boundary).

const DEFAULT_ROOT: &str = "pm-demo";

/// The one destination this panel's credentials may be released toward
/// (#22) — the same origin its granted fetch is scoped to.
const DESTINATION: &str = "https://api.dropboxapi.com";

#[derive(Default, Deserialize, Serialize)]
struct Seed {
    #[serde(default)]
    root: String,
}

#[derive(Serialize)]
struct SaveOutcome<'a> {
    provider: &'static str,
    root: &'a str,
}

/// Loose shape of the Dropbox `get_current_account` response — only the
/// fields the status line displays.
#[derive(Deserialize, Default)]
struct Account {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<AccountName>,
}

#[derive(Deserialize, Default)]
struct AccountName {
    #[serde(default)]
    display_name: Option<String>,
}

struct Ui {
    status: Element,
}

struct App {
    seed: Seed,
    root: String,
    ui: Option<Ui>,
}

thread_local! {
    static APP: RefCell<App> = RefCell::new(App {
        seed: Seed::default(),
        root: String::new(),
        ui: None,
    });
}

// --- view -------------------------------------------------------------------

fn el(tag: &str, class: &str) -> Element {
    let e = create_element(tag);
    if !class.is_empty() {
        e.set_attribute("class", class);
    }
    e
}

/// Labeled text-input row. The root folder is the ONLY input this panel
/// draws: every credential and every provider-console identifier is
/// entered in the visor's sheet, outside this region (#22).
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
    let root_el = shell::root();
    let panel = el("section", "panel-dropbox");

    let h1 = el("h1", "");
    h1.set_text_content("Connect Dropbox");
    panel.append_child(&h1);

    let root_field = field(&panel, "Root folder", DEFAULT_ROOT, TOK_ROOT);

    let creds = el("div", "hint");
    creds.set_text_content(
        "all credentials and identifiers are entered in the visor sheet — this panel never sees them",
    );
    panel.append_child(&creds);

    let seeded_root = if app.seed.root.trim().is_empty() {
        DEFAULT_ROOT.to_string()
    } else {
        app.seed.root.clone()
    };
    root_field.set_value(&seeded_root);
    app.root = seeded_root;

    let status = el("div", "status");
    panel.append_child(&status);

    let actions = el("div", "actions");
    let test = el("button", "");
    test.set_text_content("Test connection");
    listen(&test, EventKind::Click, TOK_TEST);
    actions.append_child(&test);
    panel.append_child(&actions);

    root_el.append_child(&panel);

    app.ui = Some(Ui { status });
}

fn set_status(app: &App, text: &str) {
    if let Some(ui) = &app.ui {
        ui.status.set_text_content(text);
    }
}

/// "Test connection": POST to the Dropbox account-info endpoint using the
/// `fetch` import the visor scopes to api.dropboxapi.com — that scoping IS
/// the per-destination network grant (todomvc.wit:193-197), not a policy
/// this guest enforces itself.
///
/// No authorization header is sent — this panel holds no token. The visor
/// injects the bearer credential at the granted boundary (the scoped
/// fetch shim in host/demo.ts), which is precisely why the credential
/// can stay out of component-drawn pixels.
async fn test_connection() {
    let headers: Vec<(String, String)> = Vec::new();
    let result = fetch::request(
        "POST".to_string(),
        "https://api.dropboxapi.com/2/users/get_current_account".to_string(),
        headers,
        Vec::new(),
    )
    .await;
    let text = match result {
        Ok(resp) if resp.status == 200 => {
            let account: Account = serde_json::from_slice(&resp.body).unwrap_or_default();
            let who = account
                .name
                .and_then(|n| n.display_name)
                .or(account.email)
                .unwrap_or_else(|| "(unknown)".to_string());
            format!("connected ✓ {who}")
        }
        Ok(resp) if resp.status == 401 => {
            "test failed: no token held by the visor yet — Connect or paste one in the visor sheet"
                .to_string()
        }
        Ok(resp) => {
            let body = String::from_utf8_lossy(&resp.body);
            let snippet: String = body.chars().take(120).collect();
            format!("test failed: {} {}", resp.status, snippet)
        }
        Err(e) => format!("test failed: {e}"),
    };
    APP.with(|a| set_status(&a.borrow(), &text));
}

/// The visor asks for the configuration when the user presses ITS Save.
/// `None` = not valid yet, with the reason rendered in this region.
///
/// There is nothing left here to refuse over: the app key and app secret
/// this used to validate are the visor's fields now, and REQUIREDNESS OF A
/// CREDENTIAL IS THE VISOR'S RULE, judged by kind in the visor's own pixels
/// (see `credential-needs`). The root folder simply defaults.
fn commit_config(app: &mut App) -> Option<String> {
    let root = if app.root.trim().is_empty() {
        DEFAULT_ROOT.to_string()
    } else {
        app.root.trim().to_string()
    };
    let out = SaveOutcome {
        provider: "dropbox",
        root: &root,
    };
    Some(serde_json::to_string(&out).expect("serialize outcome"))
}

async fn handle_event(ev: Event) {
    match ev.token {
        TOK_ROOT => APP.with(|a| a.borrow_mut().root = ev.value.unwrap_or_default()),
        TOK_TEST => {
            test_connection().await;
        }
        _ => {}
    }
}

// --- component exports --------------------------------------------------------

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
        handle_event(ev).await;
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
        vec![
            CredentialKind::AppKey,
            CredentialKind::AppSecret,
            CredentialKind::BearerToken,
            CredentialKind::RefreshToken,
        ]
    }

    /// This panel's configuration always points at one place: the Dropbox
    /// API origin (#22). The visor binds the credentials it holds to it and
    /// re-derives the same constant from the committed config, so this
    /// panel has no way to steer the visor's tokens elsewhere.
    fn destination() -> String {
        DESTINATION.to_string()
    }

    /// What this panel calls itself. SELF-DECLARED, therefore worth
    /// nothing as identity: the visor renders it foreign-quoted and clamped,
    /// keys its trust record on the artifact name it fetched, and lets
    /// the user assign the name they will actually recognise.
    fn nickname() -> String {
        "Dropbox".to_string()
    }

    /// This panel asks for NO pet icon (#22). The nomination export is
    /// optional in exactly this sense: `none` is a first-class answer,
    /// and the honest one for a component with no opinion. The visor
    /// then offers six glyphs of its own and the ceremony looks no
    /// different for the user — which is the property worth having, and
    /// worth exercising in at least one shipped component.
    fn mark_nomination() -> Option<String> {
        None
    }
}

export!(Component);
