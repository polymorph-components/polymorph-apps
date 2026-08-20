//! Runner: the scenario harness compiled against keyhive rev efe6ccf3 —
//! the revision `spikes/tasks-engine` ships.
#[path = "../../scenarios/scenarios.rs"]
mod scenarios;

fn main() {
    scenarios::main_for("efe6ccf3 (pinned)");
}
