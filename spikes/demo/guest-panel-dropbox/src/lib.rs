//! Dropbox storage-provider config panel (#19 x #22): a sandboxed APP,
//! never chrome. Unlike its S3 sibling this panel carries two granted
//! capabilities — the OAuth broker (chrome runs the PKCE ceremony; the
//! panel only ever sees the resulting tokens, todomvc.wit:147-162) and a
//! `fetch` import chrome scopes to `api.dropboxapi.com`. That import
//! itself IS the per-destination network grant (the #21 egress-badge
//! story) — this panel cannot reach any other host.
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
        world: "dropbox-panel",
        generate_all,
    });
}
use bindings::*;

use crate::polymorph::fetchspike::fetch;
use crate::polymorph::todomvc_spike::dom::{create_element, Element};
use crate::polymorph::todomvc_spike::events::{listen, EventKind};
use crate::polymorph::todomvc_spike::oauth_broker;
use crate::polymorph::todomvc_spike::shell;

use serde::{Deserialize, Serialize};

const TOK_APP_KEY: u32 = 1;
const TOK_APP_SECRET: u32 = 2;
const TOK_ROOT: u32 = 3;
const TOK_ACCESS: u32 = 4;
const TOK_REFRESH: u32 = 5;
const TOK_CONNECT: u32 = 6;
const TOK_TEST: u32 = 7;
const TOK_SAVE: u32 = 8;
const TOK_CANCEL: u32 = 9;

const DEFAULT_ROOT: &str = "pm-demo";

#[derive(Default, Deserialize, Serialize)]
struct Seed {
    #[serde(default, rename = "appKey")]
    app_key: String,
    #[serde(default, rename = "appSecret")]
    app_secret: String,
    #[serde(default, rename = "accessToken")]
    access_token: String,
    #[serde(default, rename = "refreshToken")]
    refresh_token: String,
    #[serde(default)]
    root: String,
}

#[derive(Serialize)]
struct SaveOutcome<'a> {
    provider: &'static str,
    #[serde(rename = "appKey")]
    app_key: &'a str,
    #[serde(rename = "appSecret")]
    app_secret: &'a str,
    #[serde(rename = "accessToken")]
    access_token: &'a str,
    #[serde(rename = "refreshToken")]
    refresh_token: &'a str,
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
    access: Element,
    refresh: Element,
    status: Element,
}

struct App {
    seed: Seed,
    app_key: String,
    app_secret: String,
    root: String,
    access: String,
    refresh: String,
    ui: Option<Ui>,
    outcome: Option<String>,
}

thread_local! {
    static APP: RefCell<App> = RefCell::new(App {
        seed: Seed::default(),
        app_key: String::new(),
        app_secret: String::new(),
        root: String::new(),
        access: String::new(),
        refresh: String::new(),
        ui: None,
        outcome: None,
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

/// Labeled text-input row. No `password` input type on this surface
/// (spikes/todomvc/host/validate.ts admits only "text"/"checkbox"), so
/// app secret and both tokens are plain text inputs — pasteable, which is
/// exactly the dev-fallback path these two token fields need to support.
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

    let app_key = field(&panel, "App key", "", TOK_APP_KEY);
    let app_secret = field(&panel, "App secret", "", TOK_APP_SECRET);
    let root_field = field(&panel, "Root folder", DEFAULT_ROOT, TOK_ROOT);
    let access = field(&panel, "Access token", "(from Connect, or paste)", TOK_ACCESS);
    let refresh = field(&panel, "Refresh token", "(from Connect, or paste)", TOK_REFRESH);

    let seeded_root = if app.seed.root.trim().is_empty() {
        DEFAULT_ROOT.to_string()
    } else {
        app.seed.root.clone()
    };
    app_key.set_value(&app.seed.app_key);
    app_secret.set_value(&app.seed.app_secret);
    root_field.set_value(&seeded_root);
    access.set_value(&app.seed.access_token);
    refresh.set_value(&app.seed.refresh_token);
    app.app_key = app.seed.app_key.clone();
    app.app_secret = app.seed.app_secret.clone();
    app.root = seeded_root;
    app.access = app.seed.access_token.clone();
    app.refresh = app.seed.refresh_token.clone();

    let status = el("div", "status");
    panel.append_child(&status);

    let actions = el("div", "actions");
    let connect = el("button", "");
    connect.set_text_content("Connect Dropbox");
    listen(&connect, EventKind::Click, TOK_CONNECT);
    let test = el("button", "");
    test.set_text_content("Test connection");
    listen(&test, EventKind::Click, TOK_TEST);
    let save = el("button", "");
    save.set_text_content("Save & connect");
    listen(&save, EventKind::Click, TOK_SAVE);
    let cancel = el("button", "");
    cancel.set_text_content("Cancel");
    listen(&cancel, EventKind::Click, TOK_CANCEL);
    actions.append_child(&connect);
    actions.append_child(&test);
    actions.append_child(&save);
    actions.append_child(&cancel);
    panel.append_child(&actions);

    root_el.append_child(&panel);

    app.ui = Some(Ui {
        access,
        refresh,
        status,
    });
}

fn set_status(app: &App, text: &str) {
    if let Some(ui) = &app.ui {
        ui.status.set_text_content(text);
    }
}

async fn connect(app_key: String) {
    if app_key.trim().is_empty() {
        APP.with(|a| set_status(&a.borrow(), "enter the app key first"));
        return;
    }
    match oauth_broker::authorize(app_key.clone()).await {
        Ok(tokens) => {
            APP.with(|a| {
                let mut app = a.borrow_mut();
                app.access = tokens.access_token.clone();
                app.refresh = tokens.refresh_token.clone();
                if let Some(ui) = &app.ui {
                    ui.access.set_value(&tokens.access_token);
                    ui.refresh.set_value(&tokens.refresh_token);
                }
                set_status(&app, "authorized ✓");
            });
        }
        Err(e) => {
            APP.with(|a| set_status(&a.borrow(), &format!("authorize failed: {e}")));
        }
    }
}

/// "Test connection": POST to the Dropbox account-info endpoint using the
/// `fetch` import chrome scopes to api.dropboxapi.com — that scoping IS
/// the per-destination network grant (todomvc.wit:193-197), not a policy
/// this guest enforces itself.
async fn test_connection(access: String) {
    let headers = vec![("authorization".to_string(), format!("Bearer {access}"))];
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
        Ok(resp) => {
            let body = String::from_utf8_lossy(&resp.body);
            let snippet: String = body.chars().take(120).collect();
            format!("test failed: {} {}", resp.status, snippet)
        }
        Err(e) => format!("test failed: {e}"),
    };
    APP.with(|a| set_status(&a.borrow(), &text));
}

fn try_save(app: &mut App) {
    if app.app_key.trim().is_empty()
        || app.app_secret.trim().is_empty()
        || app.access.trim().is_empty()
    {
        return;
    }
    let root = if app.root.trim().is_empty() {
        DEFAULT_ROOT.to_string()
    } else {
        app.root.clone()
    };
    let out = SaveOutcome {
        provider: "dropbox",
        app_key: &app.app_key,
        app_secret: &app.app_secret,
        access_token: &app.access,
        refresh_token: &app.refresh,
        root: &root,
    };
    app.outcome = Some(serde_json::to_string(&out).expect("serialize outcome"));
}

async fn handle_event(ev: Event) {
    match ev.token {
        TOK_APP_KEY => APP.with(|a| a.borrow_mut().app_key = ev.value.unwrap_or_default()),
        TOK_APP_SECRET => APP.with(|a| a.borrow_mut().app_secret = ev.value.unwrap_or_default()),
        TOK_ROOT => APP.with(|a| a.borrow_mut().root = ev.value.unwrap_or_default()),
        TOK_ACCESS => APP.with(|a| a.borrow_mut().access = ev.value.unwrap_or_default()),
        TOK_REFRESH => APP.with(|a| a.borrow_mut().refresh = ev.value.unwrap_or_default()),
        TOK_CONNECT => {
            let app_key = APP.with(|a| a.borrow().app_key.clone());
            connect(app_key).await;
        }
        TOK_TEST => {
            let access = APP.with(|a| a.borrow().access.clone());
            test_connection(access).await;
        }
        TOK_SAVE => APP.with(|a| try_save(&mut a.borrow_mut())),
        TOK_CANCEL => APP.with(|a| a.borrow_mut().outcome = Some(String::new())),
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

    async fn outcome() -> Option<String> {
        APP.with(|a| a.borrow().outcome.clone())
    }
}

export!(Component);
