//! TodoMVC as a dioxus app on the curated DOM surface: same WIT world as
//! the hand-written guest (`run` / `on-event` / `on-route`), with dioxus's
//! VirtualDom driven synchronously — handle_event → process_events →
//! render_immediate — and mutations written straight to surface imports.

use std::any::Any;
use std::cell::RefCell;
use std::rc::Rc;

wit_bindgen::generate!({
    path: "../wit",
    world: "todomvc",
});

mod app;
mod events;
mod renderer;

use dioxus_core::{ElementId, VirtualDom};
use dioxus_html::PlatformEventData;

use crate::polymorph::todomvc_spike::events::EventKind;
use crate::polymorph::todomvc_spike::shell;

thread_local! {
    static STATE: RefCell<Option<(VirtualDom, renderer::Renderer)>> =
        const { RefCell::new(None) };
}

fn event_name(kind: EventKind) -> &'static str {
    match kind {
        EventKind::Click => "click",
        EventKind::Dblclick => "dblclick",
        EventKind::Input => "input",
        EventKind::Change => "change",
        EventKind::Keydown => "keydown",
        EventKind::Blur => "blur",
    }
}

struct Component;

impl Guest for Component {
    fn run() {
        dioxus_html::set_event_converter(Box::new(events::Converter));
        let mut vdom = VirtualDom::new(app::App);
        let mut renderer = renderer::Renderer::new(shell::root());
        vdom.rebuild(&mut renderer);
        STATE.with(|s| *s.borrow_mut() = Some((vdom, renderer)));
    }

    fn on_event(ev: Event) {
        STATE.with(|s| {
            let mut state = s.borrow_mut();
            let (vdom, renderer) = state.as_mut().expect("on-event before run");
            let payload = events::Payload {
                key: ev.key,
                value: ev.value,
                checked: ev.checked,
            };
            let data: Rc<dyn Any> = Rc::new(PlatformEventData::new(Box::new(payload)));
            // bubbles=false: real-DOM bubbling already delivered a record per
            // registered listener; dioxus must not re-bubble internally.
            let event = dioxus_core::Event::new(data, false);
            vdom.runtime()
                .handle_event(event_name(ev.kind), event, ElementId(ev.token as usize));
            vdom.process_events();
            vdom.render_immediate(renderer);
        });
    }

    fn on_route(route: String) {
        STATE.with(|s| {
            let mut state = s.borrow_mut();
            let (vdom, renderer) = state.as_mut().expect("on-route before run");
            vdom.in_runtime(|| *app::ROUTE.write() = route);
            vdom.process_events();
            vdom.render_immediate(renderer);
        });
    }
}

export!(Component);
