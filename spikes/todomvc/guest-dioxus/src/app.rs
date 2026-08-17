//! TodoMVC in dioxus rsx — the app an app developer would write. Nothing in
//! this module knows about the surface: it's plain dioxus against the html
//! vocabulary, constrained to the spike's attribute allowlist (no style
//! attrs, no autofocus).

use dioxus::prelude::*;

use crate::polymorph::todomvc_spike::shell;

/// The hash route, owned by the shell and pushed in via `on-route`.
pub static ROUTE: GlobalSignal<String> = Signal::global(|| shell::route());

#[derive(Clone, PartialEq)]
struct Todo {
    id: u32,
    title: String,
    completed: bool,
}

#[component]
pub fn App() -> Element {
    let mut todos = use_signal(Vec::<Todo>::new);
    let mut next_id = use_signal(|| 1u32);
    let mut editing = use_signal(|| None::<u32>);
    let mut draft = use_signal(String::new);
    let mut edit_draft = use_signal(String::new);

    let route = ROUTE();
    let total = todos.read().len();
    let active = todos.read().iter().filter(|t| !t.completed).count();
    let completed = total - active;

    let visible: Vec<Todo> = todos
        .read()
        .iter()
        .filter(|t| match route.as_str() {
            "active" => !t.completed,
            "completed" => t.completed,
            _ => true,
        })
        .cloned()
        .collect();

    let mut commit_edit = move |id: u32, value: String| {
        if editing() != Some(id) {
            return;
        }
        editing.set(None);
        let title = value.trim().to_string();
        if title.is_empty() {
            todos.write().retain(|t| t.id != id);
        } else if let Some(t) = todos.write().iter_mut().find(|t| t.id == id) {
            t.title = title;
        }
    };

    rsx! {
        section { class: "todoapp",
            header { class: "header",
                h1 { "todos" }
                input {
                    class: "new-todo",
                    placeholder: "What needs to be done?",
                    value: "{draft}",
                    oninput: move |e| draft.set(e.value()),
                    onkeydown: move |e| {
                        if e.key() == Key::Enter {
                            let title = draft.read().trim().to_string();
                            if !title.is_empty() {
                                let id = next_id();
                                next_id.set(id + 1);
                                todos.write().push(Todo { id, title, completed: false });
                                draft.set(String::new());
                            }
                        }
                    },
                }
            }
            section { class: if total == 0 { "main hidden" } else { "main" },
                input {
                    class: "toggle-all",
                    id: "toggle-all",
                    r#type: "checkbox",
                    checked: total > 0 && active == 0,
                    onchange: move |e| {
                        let target = e.checked();
                        for t in todos.write().iter_mut() {
                            t.completed = target;
                        }
                    },
                }
                label { r#for: "toggle-all", "Mark all as complete" }
                ul { class: "todo-list",
                    for todo in visible {
                        li {
                            key: "{todo.id}",
                            class: if todo.completed && editing() == Some(todo.id) { "completed editing" } else if todo.completed { "completed" } else if editing() == Some(todo.id) { "editing" },
                            div { class: "view",
                                input {
                                    class: "toggle",
                                    r#type: "checkbox",
                                    checked: todo.completed,
                                    onchange: {
                                        let id = todo.id;
                                        move |e: FormEvent| {
                                            let checked = e.checked();
                                            if let Some(t) = todos.write().iter_mut().find(|t| t.id == id) {
                                                t.completed = checked;
                                            }
                                        }
                                    },
                                }
                                label {
                                    ondblclick: {
                                        let id = todo.id;
                                        let title = todo.title.clone();
                                        move |_| {
                                            editing.set(Some(id));
                                            edit_draft.set(title.clone());
                                        }
                                    },
                                    "{todo.title}"
                                }
                                button {
                                    class: "destroy",
                                    onclick: {
                                        let id = todo.id;
                                        move |_| {
                                            if editing() == Some(id) {
                                                editing.set(None);
                                            }
                                            todos.write().retain(|t| t.id != id);
                                        }
                                    },
                                }
                            }
                            if editing() == Some(todo.id) {
                                input {
                                    class: "edit",
                                    value: "{edit_draft}",
                                    oninput: move |e| edit_draft.set(e.value()),
                                    onkeydown: {
                                        let id = todo.id;
                                        move |e: KeyboardEvent| {
                                            if e.key() == Key::Enter {
                                                commit_edit(id, edit_draft());
                                            } else if e.key() == Key::Escape {
                                                editing.set(None);
                                            }
                                        }
                                    },
                                    onblur: {
                                        let id = todo.id;
                                        move |_| commit_edit(id, edit_draft())
                                    },
                                }
                            }
                        }
                    }
                }
            }
            footer { class: if total == 0 { "footer hidden" } else { "footer" },
                span { class: "todo-count",
                    strong { "{active}" }
                    if active == 1 { " item left" } else { " items left" }
                }
                ul { class: "filters",
                    li {
                        a {
                            class: if route.is_empty() { "selected" },
                            href: "#/",
                            "All"
                        }
                    }
                    li {
                        a {
                            class: if route == "active" { "selected" },
                            href: "#/active",
                            "Active"
                        }
                    }
                    li {
                        a {
                            class: if route == "completed" { "selected" },
                            href: "#/completed",
                            "Completed"
                        }
                    }
                }
                button {
                    class: if completed == 0 { "clear-completed hidden" } else { "clear-completed" },
                    onclick: move |_| todos.write().retain(|t| !t.completed),
                    "Clear completed"
                }
            }
        }
    }
}
