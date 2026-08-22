//! The demo app: the todomvc surface guest with its model swapped from
//! in-guest memory to the `polyvisor:tasks` data service. The app
//! never touches document surfaces — it renders whatever the service
//! reports and forwards user intent as service calls. Remote changes
//! (other devices, other users, the bucket) arrive as revision bumps
//! observed by `poll`.
//!
//! Rendering stays deliberately naive full-rebuild.

use std::cell::RefCell;

wit_bindgen::generate!({
    path: ["../../../wit/surface", "../../../wit/tasks", "../wit"],
    world: "polyvisor:todomvc/demo-app@0.0.1",
    generate_all,
});

use crate::polyvisor::surface::dom::{create_element, Element};
use crate::polyvisor::surface::events::{listen, EventKind};
use crate::polyvisor::surface::shell;
use crate::polyvisor::tasks::tasks;

const TOK_NEW: u32 = 1;
const TOK_TOGGLE_ALL: u32 = 2;
const TOK_CLEAR: u32 = 3;
const TOK_ITEM_BASE: u32 = 8;

const SLOT_TOGGLE: u32 = 0;
const SLOT_DESTROY: u32 = 1;
const SLOT_LABEL: u32 = 2;
const SLOT_EDIT: u32 = 3;

fn item_token(index: u32, slot: u32) -> u32 {
    TOK_ITEM_BASE + index * 4 + slot
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Filter {
    All,
    Active,
    Completed,
}

impl Filter {
    fn from_route(route: &str) -> Filter {
        match route {
            "active" => Filter::Active,
            "completed" => Filter::Completed,
            _ => Filter::All,
        }
    }

    fn admits(self, completed: bool) -> bool {
        match self {
            Filter::All => true,
            Filter::Active => !completed,
            Filter::Completed => completed,
        }
    }
}

struct Ui {
    new_input: Element,
    main: Element,
    toggle_all: Element,
    list: Element,
    count: Element,
    footer: Element,
    link_all: Element,
    link_active: Element,
    link_completed: Element,
    clear: Element,
    items: Vec<Element>,
}

struct App {
    /// Cached service snapshot (render source).
    items: Vec<tasks::TodoItem>,
    revision: u64,
    /// Render-order task ids: listener tokens carry the index.
    order: Vec<String>,
    filter: Filter,
    editing: Option<String>,
    status: Option<String>,
    ui: Option<Ui>,
}

thread_local! {
    static APP: RefCell<App> = RefCell::new(App {
        items: Vec::new(),
        revision: 0,
        order: Vec::new(),
        filter: Filter::All,
        editing: None,
        status: None,
        ui: None,
    });
}

// --- service access -----------------------------------------------------------

/// Refresh the cached snapshot from the service. Errors become a status
/// line instead of a trap: the engine may legitimately refuse (e.g. no
/// partition bound yet).
async fn refresh() {
    match tasks::items().await {
        Ok(snap) => APP.with(|a| {
            let mut app = a.borrow_mut();
            app.items = snap.items;
            app.revision = snap.revision;
            app.status = None;
        }),
        Err(e) => APP.with(|a| a.borrow_mut().status = Some(e)),
    }
}

// --- view ----------------------------------------------------------------------

fn el(tag: &str, class: &str) -> Element {
    let e = create_element(tag);
    if !class.is_empty() {
        e.set_attribute("class", class);
    }
    e
}

fn filter_link(href: &str, label: &str) -> (Element, Element) {
    let li = el("li", "");
    let a = el("a", "");
    a.set_attribute("href", href);
    a.set_text_content(label);
    li.append_child(&a);
    (li, a)
}

fn build_skeleton(app: &mut App) {
    let root = shell::root();
    let todoapp = el("section", "todoapp");

    let header = el("header", "header");
    let h1 = el("h1", "");
    h1.set_text_content("todos");
    let new_input = el("input", "new-todo");
    new_input.set_attribute("placeholder", "What needs to be done?");
    listen(&new_input, EventKind::Keydown, TOK_NEW);
    header.append_child(&h1);
    header.append_child(&new_input);

    let main = el("section", "main");
    let toggle_all = el("input", "toggle-all");
    toggle_all.set_attribute("type", "checkbox");
    toggle_all.set_attribute("id", "toggle-all");
    listen(&toggle_all, EventKind::Change, TOK_TOGGLE_ALL);
    let toggle_label = el("label", "");
    toggle_label.set_attribute("for", "toggle-all");
    toggle_label.set_text_content("Mark all as complete");
    let list = el("ul", "todo-list");
    main.append_child(&toggle_all);
    main.append_child(&toggle_label);
    main.append_child(&list);

    let footer = el("footer", "footer");
    let count = el("span", "todo-count");
    let filters = el("ul", "filters");
    let (li_all, link_all) = filter_link("#/", "All");
    let (li_active, link_active) = filter_link("#/active", "Active");
    let (li_completed, link_completed) = filter_link("#/completed", "Completed");
    filters.append_child(&li_all);
    filters.append_child(&li_active);
    filters.append_child(&li_completed);
    let clear = el("button", "clear-completed");
    clear.set_text_content("Clear completed");
    listen(&clear, EventKind::Click, TOK_CLEAR);
    footer.append_child(&count);
    footer.append_child(&filters);
    footer.append_child(&clear);

    todoapp.append_child(&header);
    todoapp.append_child(&main);
    todoapp.append_child(&footer);
    root.append_child(&todoapp);

    app.ui = Some(Ui {
        new_input,
        main,
        toggle_all,
        list,
        count,
        footer,
        link_all,
        link_active,
        link_completed,
        clear,
        items: Vec::new(),
    });
}

fn render(app: &mut App) {
    let editing = app.editing.clone();
    let filter = app.filter;
    let total = app.items.len();
    let active = app.items.iter().filter(|t| !t.completed).count();
    let completed = total - active;
    let status = app.status.clone();

    app.order = app
        .items
        .iter()
        .filter(|t| filter.admits(t.completed))
        .map(|t| t.id.clone())
        .collect();

    let App {
        ref items,
        ref order,
        ref mut ui,
        ..
    } = *app;
    let ui = ui.as_mut().expect("render before run()");

    ui.list.set_text_content("");
    ui.items.clear();

    for (index, id) in order.iter().enumerate() {
        let Some(t) = items.iter().find(|t| &t.id == id) else {
            continue;
        };
        let index = index as u32;
        let is_editing = editing.as_deref() == Some(t.id.as_str());
        let li_class = match (t.completed, is_editing) {
            (true, true) => "completed editing",
            (true, false) => "completed",
            (false, true) => "editing",
            (false, false) => "",
        };
        let li = el("li", li_class);

        let view = el("div", "view");
        let toggle = el("input", "toggle");
        toggle.set_attribute("type", "checkbox");
        toggle.set_checked(t.completed);
        listen(&toggle, EventKind::Change, item_token(index, SLOT_TOGGLE));
        let label = el("label", "");
        label.set_text_content(&t.title);
        listen(&label, EventKind::Dblclick, item_token(index, SLOT_LABEL));
        let destroy = el("button", "destroy");
        listen(&destroy, EventKind::Click, item_token(index, SLOT_DESTROY));
        view.append_child(&toggle);
        view.append_child(&label);
        view.append_child(&destroy);
        li.append_child(&view);

        let mut edit_input = None;
        if is_editing {
            let edit = el("input", "edit");
            edit.set_value(&t.title);
            listen(&edit, EventKind::Keydown, item_token(index, SLOT_EDIT));
            listen(&edit, EventKind::Blur, item_token(index, SLOT_EDIT));
            li.append_child(&edit);
            edit_input = Some(edit);
        }

        ui.list.append_child(&li);
        if let Some(edit) = edit_input {
            edit.focus();
        }
        ui.items.push(li);
    }

    match status {
        Some(err) => ui.count.set_text_content(&format!("service: {err}")),
        None => ui.count.set_text_content(&format!(
            "{} item{} left",
            active,
            if active == 1 { "" } else { "s" }
        )),
    }
    ui.toggle_all.set_checked(total > 0 && active == 0);

    ui.main
        .set_attribute("class", if total == 0 { "main hidden" } else { "main" });
    ui.footer.set_attribute(
        "class",
        if total == 0 { "footer hidden" } else { "footer" },
    );
    ui.clear.set_attribute(
        "class",
        if completed == 0 {
            "clear-completed hidden"
        } else {
            "clear-completed"
        },
    );

    ui.link_all
        .set_attribute("class", if filter == Filter::All { "selected" } else { "" });
    ui.link_active.set_attribute(
        "class",
        if filter == Filter::Active { "selected" } else { "" },
    );
    ui.link_completed.set_attribute(
        "class",
        if filter == Filter::Completed { "selected" } else { "" },
    );
}

async fn refresh_render() {
    refresh().await;
    APP.with(|a| render(&mut a.borrow_mut()));
}

// --- update --------------------------------------------------------------------

fn id_at(index: u32) -> Option<String> {
    APP.with(|a| a.borrow().order.get(index as usize).cloned())
}

async fn commit_edit(id: String, value: Option<String>) {
    let editing = APP.with(|a| a.borrow().editing.clone());
    if editing.as_deref() != Some(id.as_str()) {
        return;
    }
    APP.with(|a| a.borrow_mut().editing = None);
    let title = value.unwrap_or_default().trim().to_string();
    let r = if title.is_empty() {
        tasks::remove(id.clone()).await
    } else {
        tasks::set_title(id.clone(), title).await
    };
    if let Err(e) = r {
        APP.with(|a| a.borrow_mut().status = Some(e));
    }
    refresh_render().await;
}

async fn handle_event(ev: Event) {
    match ev.token {
        TOK_NEW => {
            if ev.kind == EventKind::Keydown && ev.key.as_deref() == Some("Enter") {
                let title = ev.value.unwrap_or_default().trim().to_string();
                if !title.is_empty() {
                    if let Err(e) = tasks::add(title).await {
                        APP.with(|a| a.borrow_mut().status = Some(e));
                    }
                    APP.with(|a| {
                        a.borrow()
                            .ui
                            .as_ref()
                            .expect("ui")
                            .new_input
                            .set_value("")
                    });
                    refresh_render().await;
                }
            }
        }
        TOK_TOGGLE_ALL => {
            let target = ev.checked.unwrap_or(false);
            let ids: Vec<String> = APP.with(|a| {
                a.borrow()
                    .items
                    .iter()
                    .filter(|t| t.completed != target)
                    .map(|t| t.id.clone())
                    .collect()
            });
            for id in ids {
                let _ = tasks::set_completed(id, target).await;
            }
            refresh_render().await;
        }
        TOK_CLEAR => {
            let ids: Vec<String> = APP.with(|a| {
                a.borrow()
                    .items
                    .iter()
                    .filter(|t| t.completed)
                    .map(|t| t.id.clone())
                    .collect()
            });
            for id in ids {
                let _ = tasks::remove(id.clone()).await;
            }
            refresh_render().await;
        }
        t if t >= TOK_ITEM_BASE => {
            let index = (t - TOK_ITEM_BASE) / 4;
            let slot = (t - TOK_ITEM_BASE) % 4;
            let Some(id) = id_at(index) else { return };
            match slot {
                SLOT_TOGGLE => {
                    let completed = ev.checked.unwrap_or(false);
                    let _ = tasks::set_completed(id.clone(), completed).await;
                    refresh_render().await;
                }
                SLOT_DESTROY => {
                    APP.with(|a| {
                        let mut app = a.borrow_mut();
                        if app.editing.as_deref() == Some(id.as_str()) {
                            app.editing = None;
                        }
                    });
                    let _ = tasks::remove(id.clone()).await;
                    refresh_render().await;
                }
                SLOT_LABEL => {
                    if ev.kind == EventKind::Dblclick {
                        APP.with(|a| {
                            let mut app = a.borrow_mut();
                            app.editing = Some(id.clone());
                            render(&mut app);
                        });
                    }
                }
                SLOT_EDIT => match ev.kind {
                    EventKind::Keydown => match ev.key.as_deref() {
                        Some("Enter") => commit_edit(id, ev.value).await,
                        Some("Escape") => {
                            APP.with(|a| {
                                let mut app = a.borrow_mut();
                                if app.editing.as_deref() == Some(id.as_str()) {
                                    app.editing = None;
                                    render(&mut app);
                                }
                            });
                        }
                        _ => {}
                    },
                    EventKind::Blur => commit_edit(id, ev.value).await,
                    _ => {}
                },
                _ => {}
            }
        }
        _ => {}
    }
}

// --- component exports -----------------------------------------------------------

struct Component;

impl Guest for Component {
    async fn run() {
        APP.with(|a| {
            let mut app = a.borrow_mut();
            build_skeleton(&mut app);
            app.filter = Filter::from_route(&shell::route());
        });
        refresh_render().await;
    }

    async fn on_event(ev: Event) {
        handle_event(ev).await;
    }

    async fn on_route(route: String) {
        let ready = APP.with(|a| {
            let mut app = a.borrow_mut();
            app.filter = Filter::from_route(&route);
            app.ui.is_some()
        });
        if ready {
            refresh_render().await;
        }
    }

    async fn poll() -> bool {
        // Never clobber an in-progress edit from a background poll.
        let (editing, last) = APP.with(|a| {
            let app = a.borrow();
            (app.editing.is_some(), app.revision)
        });
        if editing {
            return false;
        }
        let changed = match tasks::revision().await {
            Ok(rev) => rev != last,
            Err(_) => false,
        };
        if changed {
            refresh_render().await;
        }
        changed
    }

    /// What this app calls itself. SELF-DECLARED, therefore worth
    /// nothing as identity: the visor renders it foreign-quoted and clamped,
    /// keys its trust record on the artifact name it fetched, and lets
    /// the user assign the name they will actually recognise. Same
    /// discipline as the storage panels' `nickname` — the app is one more
    /// row in the trust table, not a privileged one.
    fn nickname() -> String {
        "TodoMVC".to_string()
    }

    /// What this component ASKS TO WEAR in the user's trust table (#22).
    ///
    /// A NOMINATION, not an assignment, and the guest is built to feel
    /// the difference: there is no companion import, no return value, no
    /// way to find out what happened. The visor shows this glyph in one
    /// place only — inside the naming ceremony's picker, quoted as the
    /// component's own, beside five the visor chose — and only if it is
    /// in the visor's curated vocabulary AND unclaimed. If the user
    /// takes it, the mark becomes THEIRS; if they pick another, or
    /// never open the ceremony, this component is never told.
    ///
    /// U+265C BLACK CHESS ROOK — the board this app keeps.
    fn mark_nomination() -> Option<String> {
        Some("♜".to_string())
    }
}

export!(Component);
