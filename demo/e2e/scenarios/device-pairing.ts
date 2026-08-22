// Device pairing over the REAL ENGINE, end to end, in both ceremonies
// (PAIRING.md §5, #22 weight classes).
//
// THE CLAIM: a device joins this account through two visor-owned
// ceremonies whose WEIGHTS differ, and nothing about either is
// reachable from, or drawable by, a component.
//
//   - ADD is heavy. It is reached from the visor's own settings sheet —
//     "add a device…", a button the VISOR draws on a sheet opened from
//     the strip — and it pays the full ceremony: the statement of
//     consequence ("full access to everything in your account"), the
//     arming delay on the grant, and a device-name field that starts
//     EMPTY and is never prefilled from anything the other side sent.
//   - JOIN is light. It is a pane-local affordance on the new device,
//     and its confirm is a single click with no arming tax: nothing
//     secret is typed there and the worst mis-tap is a cancelled join.
//
// And the two surfaces must agree: the same six SAS digits are rendered
// on BOTH, which is the property the whole ceremony rests on.
//
// REAL POINTER INTERACTIONS, on the laptop side, deliberately. This
// scenario used to drive that side through `__demo` hooks and passed
// while the ceremony was UNUSABLE: after the grant the add sheet stayed
// up with the page dimmed, and `#visor-dim` intercepted pointer events
// over the tablet pane — so the confirm the ceremony was waiting for
// could not be clicked by a human, only by a hook. A hook that calls a
// handler cannot see an element that is covered. So every laptop-side
// gesture here is `page.click`/`page.fill` against Playwright's
// actionability checks (visible, enabled, stable, NOT obscured), which
// is what makes the "after the grant, the ceremony is finishable" act
// below a real guard rather than a restatement of the code.
//
// The TABLET side may use hooks where it is only playing "the other
// device" (reading the code it renders, for instance) — except in that
// same act, where the point IS the click.
//
// ORDER. The new device displays its code FIRST, then the trusted
// device opens the ceremony and enters it (PAIRING.md §5). That is also
// the only order that works on ONE page: the add sheet dims the whole
// page, including the rectangle standing in for the other device. On
// real hardware the laptop's dim does not exist on the tablet; here it
// does, and it is a one-page artifact (documented in the demo README).
//
// WHICH DRIVER. THIS ONE IS THE REAL CEREMONY. It runs against the
// page's default pairing backend — the engine composite, one instance
// per pane, over iroh through the harness's OWN relay (e2e/run.ts spawns
// iroh-relay on an ephemeral port and every page URL carries
// `?relay=…`). So the code, the SAS, the grant and the ENROLL all
// actually cross a transport here, and the final write-through act
// crosses the post-enrollment subduction the embedder wires when a join
// completes (host/demo.ts's `wireUsSubduction`).
//
// That was not possible until recently: `user-create` trapped the guest
// (a scheduler misattribution in the runtime's async support,
// polyengine#213, fixed in @polyengine/runtime 0.3.1) and the add side's
// post-grant linger was a yield-spin that starved the joiner's ingest.
// Both are closed; PAIRING.md §6 carries the dated status.
//
// The acts themselves live in ./device-pairing-acts.ts and are shared
// verbatim with device-pairing-mock.ts — the argument is about the
// visor's ceremonies, and it must come out the same over either driver.
// Only the backend name and the convergence deadlines differ.

import type { Scenario } from "../run.ts";
import { ENGINE_WAITS, PAIRING_WHY, runPairingActs } from "./device-pairing-acts.ts";

const scenario: Scenario = {
  name: "device-pairing",
  why: PAIRING_WHY,
  run: (page) => runPairingActs(page, { backend: "engine", waits: ENGINE_WAITS }),
};

export default scenario;
