// Device pairing against the in-page MOCK driver — the visor-only
// regression harness (PAIRING.md §5/§6).
//
// THE CLAIM is the same one device-pairing.ts makes, and it is made with
// the same acts (./device-pairing-acts.ts): two ceremonies of different
// WEIGHT, the same six SAS digits on both surfaces, the grant as the
// last act on the granting device, and the account's marks reaching the
// new one. Read that file's header for the argument itself; this one
// only says why the pair exists.
//
// WHICH DRIVER, AND WHY BOTH. This scenario passes `?pairing=mock`, so
// the object implementing `PairingDriver` is host/pairing-mock.ts — an
// in-page mock with no wasm, no iroh, no relay and no wall-clock
// convergence. Everything above that seam is the SAME code: the UI, the
// wiring, the announcements and the write-through are visor/ui/pairing.ts
// either way.
//
// That makes this the FAST, TRANSPORT-INDEPENDENT half of the pair. When
// both fail, the fault is in the visor's ceremonies. When only
// device-pairing fails, it is in the engine, the transport or the
// embedder's post-enrollment sync — which is a diagnosis the suite could
// not make at all while there was only one pairing scenario.
//
// It is NOT a fallback for the real one: the engine ceremony is the
// default the demo ships and the claim the project actually makes. A
// green mock run says nothing about whether a device can join this
// account.

import type { Scenario } from "../run.ts";
import { MOCK_WAITS, PAIRING_WHY, runPairingActs } from "./device-pairing-acts.ts";

const scenario: Scenario = {
  name: "device-pairing-mock",
  why: `${PAIRING_WHY} — over the in-page mock driver`,
  // The one difference that reaches the PAGE rather than the acts: this
  // run selects the mock backend by URL.
  page: { query: { pairing: "mock" } },
  run: (page) => runPairingActs(page, { backend: "mock", waits: MOCK_WAITS }),
};

export default scenario;
