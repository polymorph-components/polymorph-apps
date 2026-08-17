//! wbg-sever: composition-time trapping stub for the wasm-bindgen JS boundary.
//!
//! A wasm32-unknown-unknown module built from a crate graph that links
//! js-sys/web-sys carries function imports in the `__wbindgen_placeholder__`
//! (and related) modules, plus describe exports and custom sections that only
//! the wasm-bindgen CLI ever consumes. None of that is WIT-shaped, so
//! `wasm-tools component new` rejects the module.
//!
//! This tool makes the "linked but never reached" state componentizable and
//! runtime-enforced:
//!   1. every function import from a `__wbindgen*` module (or a JS snippet
//!      module) is replaced by a local function of identical type whose body
//!      is `unreachable` — reaching the JS boundary traps the instance, with
//!      the shim's name (which encodes the JS API) preserved in the name
//!      section for diagnosis;
//!   2. `__wbindgen_describe*` exports and wasm-bindgen custom sections are
//!      stripped (they exist only for the wasm-bindgen CLI, which never runs).
//!
//! Non-function imports from those modules (tables/globals/memories) are an
//! error: they'd mean the graph needs the real JS glue semantics.
//!
//! Usage: wbg-sever <input.wasm> <output.wasm>

use anyhow::{bail, Context, Result};

fn is_js_boundary(module: &str) -> bool {
    module.starts_with("__wbindgen") || module.starts_with("./snippets/")
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let (input, output) = match (args.next(), args.next()) {
        (Some(i), Some(o)) => (i, o),
        _ => bail!("usage: wbg-sever <input.wasm> <output.wasm>"),
    };

    let mut module = walrus::Module::from_file(&input)
        .with_context(|| format!("parsing {input}"))?;

    // --- 1. sever JS-boundary function imports -------------------------------
    let targets: Vec<(walrus::FunctionId, String)> = module
        .imports
        .iter()
        .filter(|imp| is_js_boundary(&imp.module))
        .map(|imp| match imp.kind {
            walrus::ImportKind::Function(f) => {
                Ok((f, format!("{}::{}", imp.module, imp.name)))
            }
            _ => bail!(
                "non-function import '{}::{}' from a JS-boundary module: \
                 this graph needs real JS glue, severing would be unsound",
                imp.module,
                imp.name
            ),
        })
        .collect::<Result<_>>()?;

    let mut severed = 0usize;
    for (func_id, name) in &targets {
        let new_id = module
            .replace_imported_func(*func_id, |(body, _args)| {
                body.unreachable();
            })
            .with_context(|| format!("severing {name}"))?;
        module.funcs.get_mut(new_id).name = Some(format!("severed: {name}"));
        severed += 1;
    }

    // --- 2. strip describe exports + wasm-bindgen custom sections -------------
    let dead_exports: Vec<walrus::ExportId> = module
        .exports
        .iter()
        .filter(|e| e.name.starts_with("__wbindgen_describe"))
        .map(|e| e.id())
        .collect();
    let stripped_exports = dead_exports.len();
    for id in dead_exports {
        module.exports.delete(id);
    }

    let dead_sections: Vec<_> = module
        .customs
        .iter()
        .filter(|(_, s)| {
            let n = s.name();
            n.starts_with("__wasm_bindgen") || n.starts_with("__wbindgen")
        })
        .map(|(id, _)| id)
        .collect();
    let stripped_sections = dead_sections.len();
    for id in dead_sections {
        module.customs.delete(id);
    }

    // Drop functions (describe bodies etc.) that just became unreachable code.
    walrus::passes::gc::run(&mut module);

    module
        .emit_wasm_file(&output)
        .with_context(|| format!("writing {output}"))?;

    println!(
        "{output}: severed {severed} JS-boundary imports, stripped {stripped_exports} describe exports, {stripped_sections} custom sections"
    );
    Ok(())
}
