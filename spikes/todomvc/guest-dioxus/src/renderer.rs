//! The surface renderer: implements dioxus-core's `WriteMutations` over the
//! curated DOM surface. Semantics cribbed from the reference non-web
//! implementation (dioxus-native-dom's MutationWriter): a stack of built
//! nodes, `m`-node pops via split_off, path resolution against the top of
//! the stack, falsy attributes remove.
//!
//! Because the surface is write-only (no child traversal), each stack entry
//! carries a shadow of its template-built children so `assign_node_id` /
//! `replace_placeholder_with_nodes` paths resolve guest-side.

use std::collections::HashMap;
use std::rc::Rc;

use dioxus_core::{
    AttributeValue, ElementId, Template, TemplateAttribute, TemplateNode, WriteMutations,
};

use crate::polymorph::todomvc_spike::dom::{create_element, create_text_node, Element};
use crate::polymorph::todomvc_spike::events::{listen, EventKind};

pub struct Built {
    pub el: Rc<Element>,
    pub kids: Vec<Built>,
}

pub struct Renderer {
    nodes: HashMap<usize, Rc<Element>>,
    stack: Vec<Built>,
}

impl Renderer {
    pub fn new(root: Element) -> Self {
        let mut nodes = HashMap::new();
        nodes.insert(0usize, Rc::new(root));
        Renderer {
            nodes,
            stack: Vec::new(),
        }
    }

    fn el(&self, id: ElementId) -> Rc<Element> {
        self.nodes
            .get(&id.0)
            .unwrap_or_else(|| panic!("renderer: unknown ElementId {}", id.0))
            .clone()
    }

    fn pop_m(&mut self, m: usize) -> Vec<Built> {
        self.stack.split_off(self.stack.len() - m)
    }

    fn map_new(&mut self, built: Built, id: ElementId) {
        self.nodes.insert(id.0, built.el.clone());
        self.stack.push(built);
    }

    fn resolve_path<'a>(built: &'a Built, path: &[u8]) -> &'a Built {
        let mut cur = built;
        for &i in path {
            cur = &cur.kids[i as usize];
        }
        cur
    }
}

fn event_kind(name: &str) -> EventKind {
    match name {
        "click" => EventKind::Click,
        "dblclick" => EventKind::Dblclick,
        "input" => EventKind::Input,
        "change" => EventKind::Change,
        "keydown" => EventKind::Keydown,
        "blur" => EventKind::Blur,
        other => panic!("renderer: event '{other}' not in the surface vocabulary"),
    }
}

fn is_falsy(value: &AttributeValue) -> bool {
    match value {
        AttributeValue::None => true,
        AttributeValue::Bool(b) => !b,
        AttributeValue::Int(i) => *i == 0,
        AttributeValue::Float(f) => *f == 0.0,
        AttributeValue::Text(t) => t == "false",
        _ => false,
    }
}

fn stringify(value: &AttributeValue) -> Option<String> {
    match value {
        AttributeValue::Text(t) => Some(t.clone()),
        AttributeValue::Int(i) => Some(i.to_string()),
        AttributeValue::Float(f) => Some(f.to_string()),
        AttributeValue::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// The IDL-attribute split: `value`/`checked` go through the surface's
/// property setters; everything else is a content attribute with the
/// reference implementation's falsy-removal semantics.
fn apply_attribute(el: &Element, name: &str, value: &AttributeValue) {
    match name {
        "value" => el.set_value(&stringify(value).unwrap_or_default()),
        "checked" => el.set_checked(!is_falsy(value)),
        _ => {
            if is_falsy(value) {
                el.remove_attribute(name);
            } else if let Some(v) = stringify(value) {
                el.set_attribute(name, &v);
            }
        }
    }
}

fn build_template_node(node: &TemplateNode) -> Built {
    match node {
        TemplateNode::Element {
            tag,
            namespace,
            attrs,
            children,
        } => {
            assert!(namespace.is_none(), "renderer: element namespaces unsupported");
            let el = create_element(tag);
            for attr in attrs.iter() {
                if let TemplateAttribute::Static {
                    name,
                    value,
                    namespace,
                } = attr
                {
                    assert!(namespace.is_none(), "renderer: attr namespaces unsupported");
                    match *name {
                        "value" => el.set_value(value),
                        "checked" => el.set_checked(*value != "false"),
                        _ => el.set_attribute(name, value),
                    }
                }
            }
            let mut kids = Vec::new();
            for child in children.iter() {
                let b = build_template_node(child);
                el.append_child(&b.el);
                kids.push(b);
            }
            Built {
                el: Rc::new(el),
                kids,
            }
        }
        TemplateNode::Text { text } => Built {
            el: Rc::new(create_text_node(text)),
            kids: Vec::new(),
        },
        // Dynamic slots start as empty text nodes (position markers).
        TemplateNode::Dynamic { .. } => Built {
            el: Rc::new(create_text_node("")),
            kids: Vec::new(),
        },
    }
}

impl WriteMutations for Renderer {
    fn append_children(&mut self, id: ElementId, m: usize) {
        let kids = self.pop_m(m);
        let parent = self.el(id);
        for k in &kids {
            parent.append_child(&k.el);
        }
    }

    fn assign_node_id(&mut self, path: &'static [u8], id: ElementId) {
        let top = self.stack.last().expect("assign_node_id: empty stack");
        let node = Self::resolve_path(top, path).el.clone();
        self.nodes.insert(id.0, node);
    }

    fn create_placeholder(&mut self, id: ElementId) {
        let el = Rc::new(create_text_node(""));
        self.map_new(
            Built {
                el,
                kids: Vec::new(),
            },
            id,
        );
    }

    fn create_text_node(&mut self, value: &str, id: ElementId) {
        let el = Rc::new(create_text_node(value));
        self.map_new(
            Built {
                el,
                kids: Vec::new(),
            },
            id,
        );
    }

    fn load_template(&mut self, template: Template, index: usize, id: ElementId) {
        let built = build_template_node(&template.roots[index]);
        self.map_new(built, id);
    }

    fn replace_node_with(&mut self, id: ElementId, m: usize) {
        let new = self.pop_m(m);
        let anchor = self.el(id);
        for n in &new {
            anchor.before(&n.el);
        }
        anchor.remove();
        self.nodes.remove(&id.0);
    }

    fn replace_placeholder_with_nodes(&mut self, path: &'static [u8], m: usize) {
        // Order matters (reference impl warning): pop first, then resolve
        // the path against the NEW top of stack.
        let new = self.pop_m(m);
        let top = self
            .stack
            .last()
            .expect("replace_placeholder_with_nodes: empty stack");
        let anchor = Self::resolve_path(top, path).el.clone();
        for n in &new {
            anchor.before(&n.el);
        }
        anchor.remove();
    }

    fn insert_nodes_after(&mut self, id: ElementId, m: usize) {
        let new = self.pop_m(m);
        let anchor = self.el(id);
        for n in new.iter().rev() {
            anchor.after(&n.el);
        }
    }

    fn insert_nodes_before(&mut self, id: ElementId, m: usize) {
        let new = self.pop_m(m);
        let anchor = self.el(id);
        for n in &new {
            anchor.before(&n.el);
        }
    }

    fn set_attribute(
        &mut self,
        name: &'static str,
        ns: Option<&'static str>,
        value: &AttributeValue,
        id: ElementId,
    ) {
        assert!(ns.is_none(), "renderer: attribute namespaces unsupported");
        let el = self.el(id);
        apply_attribute(&el, name, value);
    }

    fn set_node_text(&mut self, value: &str, id: ElementId) {
        self.el(id).set_text_content(value);
    }

    fn create_event_listener(&mut self, name: &'static str, id: ElementId) {
        listen(&self.el(id), event_kind(name), id.0 as u32);
    }

    fn remove_event_listener(&mut self, _name: &'static str, _id: ElementId) {
        // The surface has no unlisten; nodes take their listeners with them
        // on removal, and dioxus drops the vdom-side handler either way.
    }

    fn remove_node(&mut self, id: ElementId) {
        let el = self.el(id);
        el.remove();
        self.nodes.remove(&id.0);
    }

    fn push_root(&mut self, id: ElementId) {
        let el = self.el(id);
        self.stack.push(Built {
            el,
            kids: Vec::new(),
        });
    }
}
