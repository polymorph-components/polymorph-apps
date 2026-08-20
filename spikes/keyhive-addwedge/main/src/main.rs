//! Runner: the same scenario harness compiled against keyhive `main`.
//! The resolved commit is recorded in this workspace's Cargo.lock.
#[path = "../../scenarios/scenarios.rs"]
mod scenarios;

fn main() {
    scenarios::main_for("branch main");
}
