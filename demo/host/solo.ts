// THE SOLO PAGE: one device, one engine, one visor, one app.
//
// The three-pane demo (host/demo.ts) puts a whole account on one screen
// so a reader can watch both ends of every beat at once. That is a good
// theatre and a bad model of a deployment: the two devices share a
// process, a page, a storage origin and a boot, so several things a real
// second device must do for itself are simply not exercised.
//
// This page is the other half. It is ONE DEVICE — one engine instance in
// its own page, with its own storage keys — and pairing runs between TWO
// INDEPENDENT PAGES over the relay. Everything the demo could hand a
// second pane out of band, this page has to obtain over the wire:
//
//   - the ADDER's endpoint and agent ids, so the joiner can dial back
//     (engine.wit's `pair-enrollment.peer-agent-id` /
//     `peer-endpoint-id`, added for exactly this — see runtime/engine.ts's
//     `PairEnrollment`);
//   - the account's tasks partition id, read out of the synced
//     user-system doc's partition-pointer map (#36), which is the only
//     channel a freshly-joined device has for it.
//
// It is deliberately a SECOND, SMALLER EMBEDDER rather than a copy of
// demo.ts: it builds on runtime/* and visor/* the same way, and where it
// resembles demo.ts (the app mount, the post-enrollment wiring) it is
// because those blocks are the framework's shape, not this file's.
//
// WHAT V1 DOES NOT HAVE, and does not pretend to: no bucket, and
// therefore no storage picker and no provider panels (the three storage
// seams below REFUSE, which is the honest wiring for an instance with no
// destination — #7's "authority in the instance"); no collaborator; no
// three-pane theatre.

import {
  artifactsFromEnvelope,
  ComponentException,
  instantiate,
} from "@polyengine/runtime/embedder";
import { createRunner, type Runner } from "../../visor/surface/runner.ts";
import { createFrameBackend } from "../../visor/frame/frame-backend.ts";
import { createSurface } from "../../visor/surface/surface.ts";
import { initVisor, type SurfaceIdentity, VISOR_HUES } from "../../visor/ui/visor.ts";
import { registerVisorSheets } from "../../visor/ui/sheets.ts";
import {
  type AddPaneHandle,
  type AnnounceSink,
  drainAnnouncements,
  mountAddPane,
  mountJoinPane,
  reconcileFromDriver,
  usCacheKeys,
  visorAnnounceSink,
} from "../../visor/ui/pairing.ts";
import type { PairingDriver } from "../../visor/ui/pairing-driver.ts";
import { createEnginePairingDriver } from "../../runtime/pairing-engine.ts";
import type { UiEvent } from "../../visor/surface/events.ts";
import {
  type Engine,
  type EngineArtifacts,
  type EngineNet,
  hex,
  newEngine,
  unhex,
  until,
} from "../../runtime/engine.ts";

const params = new URLSearchParams(location.search);
// Same default as demo.ts: n0's public relay, overridable with ?relay=…
// (the e2e harness points every page at its own ephemeral one).
const RELAY = params.get("relay") ?? "https://use1-1.relay.n0.iroh.link";

// --- storage keys -----------------------------------------------------------
//
// `pm-solo-*`, NOT `pm-demo-*`. The two pages are served from one origin
// and therefore share localStorage; sharing the identity record and the
// anchor hue between them would make the solo page's "this is a separate
// device" claim false the moment anyone opened the demo first. The visor
// itself takes the keys as configuration precisely so two embedders on
// one origin can be two devices.
const VISOR_KEY = "pm-solo-visor-hue";
const IDENTITY_KEY = "pm-solo-identity";
const MARKS_KEY = "pm-solo-surface-marks";
const US_CACHE_KEYS = usCacheKeys("pm-solo");

const BUILD =
  (document.querySelector('meta[name="pm-build"]') as HTMLMetaElement | null)?.content ?? "";
const stamp = (path: string) => (BUILD && BUILD !== "__BUILD__" ? `${path}?v=${BUILD}` : path);

/** The artifact name the visor fetched the app by — and therefore the
 * key of the app's row in the trust table (provenance, never a
 * self-declared name). */
const APP_ARTIFACT = "app";
/** The account's name for its todo partition in the user-system doc's
 * pointer map. The joiner looks the partition up by THIS string, so it
 * is a contract between the two pages and not a local convention. */
const TASKS_POINTER = "tasks";

async function fetchArtifacts(name: string): Promise<EngineArtifacts> {
  const [envelope, bytes] = await Promise.all([
    fetch(stamp(`./${name}.plan.json`)).then((r) => {
      if (!r.ok) throw new Error(`${name} plan: HTTP ${r.status}`);
      return r.text();
    }),
    fetch(stamp(`./${name}.component.wasm`)).then((r) => {
      if (!r.ok) throw new Error(`${name} wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return { envelope, bytes: new Uint8Array(bytes) };
}

function err(e: unknown): string {
  const p = (e as { payload?: unknown }).payload;
  return typeof p === "string" ? p : String(e);
}

/** NO BUCKET IN V1, and the wiring says so rather than a config field.
 *
 * All three storage seams and the signer refuse. An instance with no
 * destination is not an instance with a blank endpoint string — what it
 * can reach is a property of what its imports were wired to (#7), and
 * these were wired to refusal. A refusal is the err side of the WIT
 * result (a branded ComponentException, never an unbranded throw), so
 * the guest observes a denied egress and can report it, rather than
 * trapping. Same shape as host/probe-net.ts's `probeNoNet`; declared
 * here because that module states it is not part of the browser bundle. */
const NO_STORE: EngineNet = {
  ownerFetch: () =>
    Promise.reject(
      new ComponentException("store-owner-fetch: no storage destination on this device"),
    ),
  publicFetch: () =>
    Promise.reject(
      new ComponentException("store-public-fetch: no storage destination on this device"),
    ),
  sharedFetch: () =>
    Promise.reject(
      new ComponentException("store-shared-fetch: no storage destination on this device"),
    ),
  signer: () =>
    Promise.reject(
      new ComponentException("store-signer: no signing credential wired for this instance"),
    ),
};

interface AppExports {
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  poll(): Promise<boolean>;
}

// --- the one background chain ----------------------------------------------
//
// One engine instance, several callers (the join pane's poll, the add
// sheet's poll, the announcement drain, this file's own wiring). The
// guest is single-threaded and its async support is cooperative, so
// overlapping calls are serialized HERE, in exactly one place — see
// demo.ts's note on the deadlock a caller earns by wrapping itself a
// second time.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(f: () => Promise<T>): Promise<T> {
  const next = chain.then(f, f);
  chain = next.catch(() => {});
  return next;
}

/** Every method of a driver put on the chain. Mechanical, so it cannot
 * forget one: it is built from the object it wraps. */
function serialized(raw: PairingDriver): PairingDriver {
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(raw) as (keyof PairingDriver)[]) {
    const fn = raw[key];
    if (typeof fn !== "function") continue;
    out[key as string] = (...args: unknown[]) =>
      enqueue(() => (fn as (...a: unknown[]) => Promise<unknown>).apply(raw, args));
  }
  return out as unknown as PairingDriver;
}

/** Skip-a-tick-if-the-last-one-is-still-running, with no queueing of its
 * own (the callee is already on the chain). */
function poll(everyMs: number, f: () => Promise<unknown>): number {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    f().catch(() => {}).finally(() => {
      running = false;
    });
  }, everyMs) as unknown as number;
}

// --- boot -------------------------------------------------------------------

async function boot() {
  const banner = document.getElementById("banner")!.querySelector(".bar-inner")!;
  const say = (s: string) => {
    banner.textContent = s;
    console.log(`[solo] ${s}`);
  };
  const statusEl = document.getElementById("solo-status")!;
  const status = (line: string) => {
    statusEl.textContent = line;
  };

  // DECLARED BEFORE `initVisor`, not beside the app mount: the config
  // below closes over it, and the visor renders the context during
  // setup — a `let` declared afterwards would be in its temporal dead
  // zone at exactly that moment.
  let appSurface: SurfaceIdentity | null = null;

  const visor = initVisor({
    hueKey: VISOR_KEY,
    identityKey: IDENTITY_KEY,
    // ONE app surface and no nested places: the strip's context falls
    // back to the app's row and there is nothing to override it with.
    appSurface: () => appSurface,
  });
  if (visor.fresh) {
    visor.announce("new visor colour set for this device — remember it", 15000);
  }
  const announce: AnnounceSink = visorAnnounceSink(visor);

  say("fetching artifacts…");
  const [engineArt, appArt] = await Promise.all([
    fetchArtifacts("engine"),
    fetchArtifacts(APP_ARTIFACT),
  ]);

  say("instantiating the engine…");
  const engine: Engine = await newEngine("solo", engineArt, NO_STORE);
  const driver = engine.driver;

  say("identity…");
  const myId = unhex(await driver.init(false));
  status(`id ${hex(myId).slice(0, 8)}…`);

  // BOUND AT BOOT, unconditionally. Pairing rides iroh and the guest
  // refuses an unbound instance (guest/src/pairing.rs's "iroh-bind
  // first"), and BOTH roles need it here: this page may turn out to be
  // the joiner (which dials) or the adder (which accepts). A bind
  // deferred to the moment a role is chosen would fail at the worst
  // possible time, inside a ceremony the user has already started.
  say("binding the transport…");
  let myEndpoint: Uint8Array | null = null;
  try {
    myEndpoint = unhex(await driver.irohBind(RELAY));
  } catch (e) {
    status(`pairing transport unavailable: ${err(e)}`);
    console.warn(`[solo] iroh-bind failed: ${err(e)}`);
  }

  const us = serialized(createEnginePairingDriver(driver));

  // --- the app -------------------------------------------------------------

  let appRunner: Runner | null = null;
  let appMounted = false;

  /** Instantiate the app guest over THIS page's engine, in a real
   * sandboxed frame (#16). Structurally the same block as demo.ts's
   * `mountApp` (demo.ts ~1194-1246), and deliberately so: the frame
   * backend, the surface, the runner and the `polyvisor:tasks` import
   * being the engine's own export object ARE the framework's app-mount
   * shape. What differs is only that there is one of it. */
  const mountApp = async () => {
    if (appMounted) return;
    appMounted = true;
    const container = document.getElementById("solo-app")!;
    let dispatch: (ev: UiEvent) => void = () => {};
    const frameBackend = createFrameBackend(container, (ev) => dispatch(ev));
    const backend = await frameBackend.backend;
    const surface = createSurface(backend, () => "");
    const instance = await instantiate(
      artifactsFromEnvelope(appArt.envelope, appArt.bytes),
      {
        ...surface.imports,
        // The framework seam: the app's data-service import IS this
        // engine instance's export.
        "polyvisor:tasks/tasks@0.1.0": engine.tasks,
      },
    );
    const app = instance.exports as unknown as AppExports;
    const runner = createRunner(surface);
    dispatch = (ev) => {
      runner.call(() => app.onEvent(ev)).catch((e) => status(`event: ${err(e)}`));
    };
    await runner.call(() => app.run());
    appRunner = runner;
    // The app's row in the trust table: ONE artifact, ONE record, keyed
    // by the name the visor fetched it by.
    const { mark, isNew } = sheets.marks.mark(APP_ARTIFACT);
    appSurface = {
      // `name` IS the provenance key — the name the visor fetched the
      // artifact by, never the component's self-declared one.
      name: APP_ARTIFACT,
      // v1 does not read the app's self-declared nickname or its mark
      // nomination: both are extra seam-crossings whose only consumer is
      // the naming ceremony's presentation, and the solo page's claim is
      // about pairing. Falling back to the provenance key is the same
      // NO-FABRICATION answer demo.ts gives when the read fails.
      nickname: APP_ARTIFACT,
      icon: mark.icon,
      isNew,
      petname: mark.petname,
      firstSeen: mark.firstSeen,
    };
    visor.renderContext();
    // Remote changes surface as revision bumps; poll on a UI cadence,
    // skipping a tick whose predecessor is still in flight (an unbounded
    // `runner.call` chain is how demo.ts once wedged a page).
    let polling = false;
    setInterval(() => {
      if (polling) return;
      polling = true;
      runner.call(() => app.poll()).catch(() => {}).finally(() => {
        polling = false;
      });
    }, 400);
    document.getElementById("first-run")!.hidden = true;
    say("ready");
  };

  // --- the visor's own sheets ----------------------------------------------

  /** Where the ADD ceremony is opened from (installed below, once the
   * add tenant exists). The settings sheet is registered before it, so
   * the action is a thunk rather than a forward reference. */
  let openAddDevice = () => {};

  const sheets = registerVisorSheets(visor, {
    marksKey: MARKS_KEY,
    onIdentityCommitted: (rec, hue) => {
      // WRITE-THROUGH (PAIRING.md §5): the visor has already stored and
      // painted; the partition is the source of truth catching up, so a
      // failure here is announced rather than hidden.
      void (async () => {
        const res = await us.usProfileSet({
          displayName: rec.name ?? "",
          hue: hueIndexOf(hue),
        });
        if (!res.ok) announce(`could not save your profile: ${res.error}`, true);
      })();
    },
    onNamed: (provenance, petname, icon) => {
      if (appSurface && appSurface.name === provenance) {
        appSurface = { ...appSurface, petname, icon, isNew: false };
        visor.renderContext();
      }
      void (async () => {
        const res = await us.usMarkPut({
          provenance,
          petname,
          // The glyph itself crosses, opaquely (engine.wit's
          // `us-mark.icon`): the vocabulary is the visor's.
          icon,
          createdAt: Date.now(),
          needsReconfirm: false,
        });
        if (!res.ok) announce(`could not record the name in your account: ${res.error}`, true);
      })();
    },
    onForgotten: (provenance) => {
      if (appSurface && appSurface.name === provenance) {
        // BOTH HALVES GO: forgetting deletes the record, so a cached
        // surface keeping its glyph would leave the strip wearing a mark
        // the visor no longer holds.
        appSurface = { ...appSurface, petname: undefined, icon: "" };
        visor.renderContext();
      }
      void (async () => {
        const res = await us.usMarkForget(provenance);
        if (!res.ok) announce(`could not forget it in your account: ${res.error}`, true);
      })();
    },
    onReset: () => {
      for (const k of [US_CACHE_KEYS.hue, US_CACHE_KEYS.name, US_CACHE_KEYS.marks]) {
        localStorage.removeItem(k);
      }
    },
    resetConsequences: ["the devices you paired with this one"],
    extraActions: [{
      label: "add a device…",
      key: "add-device",
      hint: "show a code on the other device, then enter it here",
      onSelect: () => openAddDevice(),
    }],
  });

  /** The account stores a PALETTE INDEX, never a raw angle (PAIRING.md
   * §4). An angle the palette does not contain — unreachable from the
   * settings sheet — falls back to index 0 rather than writing a number
   * the other device cannot render. */
  const hueIndexOf = (angle: number) => {
    const i = VISOR_HUES.indexOf(angle);
    return i < 0 ? 0 : i;
  };

  // --- cross-page sync ------------------------------------------------------
  //
  // PAIRING.md §2 step 7's embedder half, and the beat this whole page
  // exists to exercise: pairing grants MEMBERSHIP and stops. Nothing
  // flows between the two pages until someone connects them and
  // subscribes, and only the embedder knows the transport.
  //
  // DIRECTION IS MANDATORY AND IT IS "WRITER ACCEPTS, READER DIALS"
  // (issue #78): the adder posts an ACCEPTOR after its grant, the joiner
  // DIALS the ids its enrollment carried. Reversed, both sides report a
  // healthy connection, both sync handles report ready, and nothing ever
  // arrives — a failure with no symptom but silence, which is why the
  // direction is written down here rather than left to whichever call
  // happened to be first.

  let usSynced = false;

  /** Subscribe to `tree` with `peer`, both directions being the caller's
   * to arrange. `subscribe` is what makes a LATER write push rather than
   * wait for a poll. */
  const subscribe = async (peer: Uint8Array, tree: Uint8Array, what: string) => {
    const h = await driver.syncStart(peer, tree, true);
    await until(`subscribed to ${what}`, () => driver.syncStatus(h), 30_000);
  };

  // --- role: the JOINER (this page is the new device) ----------------------

  const joinHost = document.getElementById("solo-join")!;
  let joinWired = false;
  let joinAttempts = 0;
  const WIRE_ATTEMPTS = 3;

  /** Everything after ENROLLED, on the joining side.
   *
   * EXACTLY ONCE PER ENROLLMENT, retry-bounded: a second wiring is a
   * second connection and a second subscription for the same pair, so
   * the guard is set before the first await rather than after the last. */
  const joinerWire = async () => {
    if (joinWired) return;
    joinWired = true;
    joinAttempts++;
    try {
      if (!myEndpoint) throw new Error("this device never bound an iroh endpoint");
      // The RAW driver, not the adapter: the peer ids are the
      // embedder's business and the visor's contract deliberately does
      // not carry them (runtime/pairing-engine.ts's `toMockJoinState`).
      // `pair-join-status` keeps answering `enrolled`, so reading it back
      // here is a poll and not a race with the join pane's own tick.
      const enrollment = await until("this device's enrollment", async () => {
        const s = await enqueue(() => driver.pairJoinStatus());
        return s.kind === "enrolled" ? s.value : false;
      }, 30_000, 200);
      if (enrollment.peerAgentId.length === 0 || enrollment.peerEndpointId.length === 0) {
        // CONTRACT: engine.wit says an empty id means "not observed".
        // There is nothing honest to dial with, so this reports rather
        // than guessing at the other device.
        throw new Error("the enrollment carried no peer ids — cannot reach the other device");
      }
      const peer = enrollment.peerAgentId;
      await enqueue(async () => {
        // READER DIALS.
        const conn = await driver.irohStart(true, enrollment.peerEndpointId, RELAY, peer);
        await until("the other device answers", () => driver.connStatus(conn), 30_000);
        await subscribe(peer, enrollment.partitionId, "your account");
      });
      // The tasks partition id has no channel but the account's own
      // pointer map — which is why the map exists (#36).
      // THE RAW DRIVER AGAIN, and for the same reason as the peer ids:
      // `us-partitions` is not on the visor's `PairingDriver` contract
      // and must not be added to it. Which partition an app is mounted
      // on is the embedder's concern; the trusted surface has no use for
      // a partition id and no business holding one.
      const pointer = await until("your account's todo list", async () => {
        const list = await enqueue(() => driver.usPartitions());
        return list.find((p) => p.name === TASKS_POINTER) ?? false;
      }, 60_000, 250);
      const tasksId = pointer.id;
      await enqueue(async () => {
        await driver.adoptPartition(tasksId);
        await subscribe(peer, tasksId, "your todo list");
      });
      usSynced = true;
      console.log("[solo] subduction wired: this device ⇄ the device that added it");
      await mountApp();
    } catch (e) {
      if (joinAttempts < WIRE_ATTEMPTS) joinWired = false;
      else announce(`could not sync this device with your account: ${err(e)}`, true);
      console.warn(`[solo] post-enrollment wiring failed (attempt ${joinAttempts}): ${err(e)}`);
    }
  };

  const joinHandle = mountJoinPane(joinHost, us, announce, (profile) => {
    // THE ADOPTION BEAT: this device takes the account's colour and name.
    // The UI reports the value; painting is the consumer's job.
    const angle = VISOR_HUES[profile.hue] ?? VISOR_HUES[0];
    visor.commitHue(angle);
    const rec = visor.identity();
    if (profile.displayName) visor.saveIdentity({ ...rec, name: profile.displayName });
    visor.renderIdentity();
    status(`this device now follows your account: ${profile.displayName || "(unnamed)"}`);
  });
  joinHost.hidden = true;

  // --- role: the ADDER (this page already has the account) -----------------

  let addTicker = 0;
  let acceptorPosted = false;
  let acceptorConn: number | null = null;
  let adderWired = false;
  let adderAttempts = 0;

  /** Everything after the GRANT, on the adding side.
   *
   * The acceptor is posted FIRST and unconditionally: the joiner is
   * already dialling by the time it has an enrollment, and a listener
   * that arrives after the dial is a dial into nothing. Only then does
   * this side wait to learn WHO joined — from its own us-doc `devices`
   * map, whose entries are keyed by agent id and which THIS device wrote
   * at enrollment (usdoc.rs's `enroll_device`). There is no need to ask
   * the peer for a name it would only be claiming. */
  const adderWire = async () => {
    if (adderWired) return;
    adderWired = true;
    adderAttempts++;
    try {
      if (!acceptorPosted) {
        acceptorPosted = true;
        // WRITER ACCEPTS: no peer, no expectation — this side answers
        // whoever it granted.
        acceptorConn = await enqueue(() =>
          driver.irohStart(false, new Uint8Array(), RELAY, new Uint8Array())
        );
      }
      const mine = hex(myId);
      const joiner = await until("the joined device", async () => {
        const res = await us.usDevicesList();
        if (!res.ok) return false;
        return res.value.find((d) => d.agentId !== mine && !d.revoked) ?? false;
      }, 60_000, 250);
      const peer = unhex(joiner.agentId);
      // WAIT FOR THE DIAL BEFORE SUBSCRIBING. The device entry above is
      // THIS device's own write, made at enrollment, so it appears long
      // before the joiner has dialled — and a `sync-start` issued
      // against a peer this side has no connection to reports a healthy
      // handle and delivers nothing (the same silent shape as the
      // reversed-direction bug, #78). The headless smoke waits for both
      // sides' `conn-status` before either subscribes
      // (host/pairing-bringup.ts) and so does this.
      if (acceptorConn === null) throw new Error("no acceptor connection to wait on");
      await until(
        "the new device to connect",
        () => driver.connStatus(acceptorConn as number),
        60_000,
        250,
      );
      const partitions = await enqueue(() => driver.usPartitions());
      const tasks = partitions.find((p) => p.name === TASKS_POINTER);
      await enqueue(async () => {
        // The user-system doc's own id is not exposed by the `us-*`
        // surface by design, and it does not need to be: the engine
        // subscribes the us doc to every known peer itself
        // (usdoc.rs's `ensure_subscriptions`, which runs on every pump).
        // What the engine cannot do for us is the TASKS partition — it
        // has no name for it — so that one is subscribed here.
        if (tasks) await subscribe(peer, tasks.id, "your todo list");
      });
      usSynced = true;
      console.log("[solo] subduction wired: this device ⇄ the device it added");
    } catch (e) {
      if (adderAttempts < WIRE_ATTEMPTS) adderWired = false;
      else announce(`could not sync the new device with your account: ${err(e)}`, true);
      console.warn(`[solo] post-grant wiring failed (attempt ${adderAttempts}): ${err(e)}`);
    }
  };

  const addTenant = visor.drawer.tenant<{ container: HTMLElement }>({
    name: "add-device",
    exclusive: true,
    dim: true,
    context: () => ({ kind: "settings" }),
  });

  openAddDevice = () => {
    const container = document.createElement("div");
    container.className = "cred-sheet";
    container.id = "pair-add-sheet";
    const session = { container };
    const opened = addTenant.open(session, () => {
      const heading = document.createElement("h2");
      heading.textContent = "Add a device";
      const body = document.createElement("div");
      container.replaceChildren(heading, body);
      const handle: AddPaneHandle = mountAddPane(body, us, announce, {
        // The settings sheet's "add a device…" WAS the entry
        // affordance; asking again would be asking twice.
        entry: "immediate",
        onGranted: () => {
          if (addTenant.owns(session)) addTenant.close();
          // THE GRANT IS THE TRIGGER. The joiner cannot dial a device
          // that is not listening, and after the grant the ceremony is
          // entirely the other device's turn — so the acceptor goes up
          // here, not when the ENROLLED state is eventually observed.
          void adderWire();
        },
      });
      clearInterval(addTicker);
      addTicker = poll(200, async () => {
        await handle.tick();
        if (handle.settled()) clearInterval(addTicker);
      });
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.onclick = () => {
        if (addTenant.owns(session)) addTenant.close();
      };
      container.append(close);
      return { root: container };
    });
    if (!opened) clearInterval(addTicker);
  };

  // --- first run, or not ----------------------------------------------------

  /** Create the account this device is the first device of.
   *
   * ORDER IS LOAD-BEARING, and it is the order pairing-bringup.ts and
   * the native acts prove: user-create → create the tasks partition →
   * delegate it to the USER GROUP → seal → publish the pointer.
   *
   * DELEGATED TO THE GROUP, NEVER TO A DEVICE. A device added later
   * joins the group, so a group-delegated partition is readable by it
   * through the membership pairing already granted — whereas a partition
   * delegated to this device's individual would need a fresh grant per
   * device, made by a device that may not be running. */
  const newAccount = async () => {
    const created = await us.userCreate({
      displayName: visor.identity().name ?? "",
      hue: hueIndexOf(visor.committedHue()),
    });
    if (!created.ok) throw new Error(created.error);
    const userGroupId = unhex(created.value);
    const tasksId = await enqueue(async () => {
      const id = await driver.createPartition();
      await driver.khAddMember(id, userGroupId, "edit");
      await driver.sealPartition(id);
      await driver.usPartitionPut(TASKS_POINTER, id);
      return id;
    });
    console.log(`[solo] account created; tasks partition ${hex(tasksId).slice(0, 8)}…`);
    await mountApp();
  };

  const firstRun = document.getElementById("first-run")!;

  /** Reveal the fork (the markup is web/solo.html's — page furniture,
   * not a ceremony) and wire its two buttons. */
  const offerFirstRun = () => {
    firstRun.hidden = false;
    const newBtn = document.getElementById("solo-new-account") as HTMLButtonElement;
    const joinBtn = document.getElementById("solo-join-account") as HTMLButtonElement;
    newBtn.onclick = () => {
      newBtn.disabled = true;
      joinBtn.disabled = true;
      status("creating your account…");
      newAccount().catch((e) => {
        status(`could not create an account: ${err(e)}`);
        newBtn.disabled = false;
        joinBtn.disabled = false;
      });
    };
    joinBtn.onclick = () => {
      firstRun.hidden = true;
      joinHost.hidden = false;
      // The join pane draws its own entry button; this click is the
      // user's, forwarded, so the ceremony still starts from visor
      // pixels and this file still never renders a code.
      (joinHost.querySelector("button") as HTMLButtonElement | null)?.click();
    };
  };

  // DOES THIS DEVICE ALREADY HOLD THE ACCOUNT? `us-profile-get` refuses
  // when there is no user-system partition, and that refusal IS the
  // question's answer.
  //
  // CONTRACT: v1 keeps no engine identity across reloads — `init` mints
  // a fresh one every boot — so in practice this probe fails on every
  // load and the fork below is what a visitor sees. The returning-visit
  // branch is written the way the ruling states it because it is the
  // shape the moment identity is persisted, and a branch that silently
  // assumed first-run would then be wrong in the direction that destroys
  // an account.
  const probe = await us.usProfileGet();
  if (probe.ok) {
    say("your account…");
    await reconcileFromDriver(us, US_CACHE_KEYS, announce);
    const parts = await enqueue(() => driver.usPartitions());
    const tasks = parts.find((p) => p.name === TASKS_POINTER);
    if (tasks) {
      await mountApp();
    } else {
      // An account with no todo list is not a first run — offering to
      // create a SECOND account here would be the page guessing at a
      // state it does not understand.
      status("this account has no todo list yet");
      say("ready — no todo list on this account");
    }
  } else {
    offerFirstRun();
    say("ready — no account on this device yet");
  }

  // The join pane's tick is one driver read; its `true` is the
  // JOIN-COMPLETED edge, which is where the embedder owes the pair a
  // sync path.
  poll(250, async () => {
    if (await joinHandle.tick()) void joinerWire();
  });
  // Remotely-caused identity changes are announced, never silent.
  poll(1000, () => drainAnnouncements(us, announce));

  // --- driving hooks --------------------------------------------------------
  //
  // Deliberately tight (the __demo.pairing pattern): what the e2e
  // scenario needs to act as a user and to read what the user would see,
  // and nothing that would let a test bypass a ceremony's own gates.
  (globalThis as unknown as Record<string, unknown>).__solo = {
    /** Which side of the wire this page turned out to be, and whether it
     * has an account at all. */
    hasAccount: async () => (await us.usProfileGet()).ok,
    usSynced: () => usSynced,
    /** The first-run fork, clicked as a user clicks it. */
    newAccount: () =>
      (document.getElementById("solo-new-account") as HTMLButtonElement | null)?.click(),
    joinAccount: () =>
      (document.getElementById("solo-join-account") as HTMLButtonElement | null)?.click(),
    /** The 79-char code as the JOIN pane renders it, ungrouped. */
    code: () =>
      (joinHost.querySelector(".pm-code") as HTMLElement | null)?.textContent?.replace(
        /\s+/g,
        "",
      ) ?? "",
    sasJoin: () => (joinHost.querySelector(".pm-sas") as HTMLElement | null)?.textContent ?? "",
    joinConfirm: () => {
      const btns = Array.from(joinHost.querySelectorAll("button")) as HTMLButtonElement[];
      btns.find((b) => (b.textContent ?? "").includes("I initiated"))?.click();
    },
    /** The add ceremony, entered the way a user enters it: the strip's
     * settings button, then the sheet's own action. */
    openAdd: () => {
      (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click();
      (document.querySelector(
        '#visor-drawer-inner .settings-extra-action[data-action="add-device"]',
      ) as HTMLButtonElement | null)?.click();
    },
    addOpen: () => addTenant.isOpen(),
    pasteCode: (code: string) => {
      const ta = document.querySelector("#pair-add-sheet textarea") as HTMLTextAreaElement | null;
      if (!ta) return false;
      ta.value = code;
      return true;
    },
    connect: () => {
      const btns = Array.from(
        document.querySelectorAll("#pair-add-sheet button"),
      ) as HTMLButtonElement[];
      btns.find((b) => b.textContent === "connect")?.click();
    },
    sasAdd: () =>
      (document.querySelector("#pair-add-sheet .pm-sas") as HTMLElement | null)?.textContent ?? "",
    sasContinue: () => {
      const btns = Array.from(
        document.querySelectorAll("#pair-add-sheet button"),
      ) as HTMLButtonElement[];
      btns.find((b) => (b.textContent ?? "").includes("codes match"))?.click();
    },
    /** CLICKS, so a driver meets the arming delay exactly as a user
     * does: a click before it elapses lands on a disabled button. */
    grantArmed: () => {
      const b = document.querySelector("#pair-add-sheet button.pm-armed") as
        | HTMLButtonElement
        | null;
      return b === null ? null : !b.disabled;
    },
    typeDeviceName: (value: string) => {
      const input = document.querySelector("#pair-add-sheet input[type=text]") as
        | HTMLInputElement
        | null;
      if (input) input.value = value;
    },
    grant: () =>
      (document.querySelector("#pair-add-sheet button.pm-armed") as HTMLButtonElement | null)
        ?.click(),
    /** The todo list as the ENGINE holds it. The e2e scenario drives the
     * real app UI through the frame; this is what it ASSERTS on, because
     * convergence is a claim about the partition and reading it out of
     * the frame's rendered rows would test the frame instead. */
    todos: async () => {
      const snap = await enqueue(() => engine.tasks.items());
      return snap.items.map((i) => i.title);
    },
    /** The account's marks, for the petname-converges beat. */
    marks: async () => {
      const res = await us.usMarksList();
      return res.ok ? res.value : [];
    },
    putMark: async (provenance: string, petname: string, icon: string) => {
      const res = await us.usMarkPut({
        provenance,
        petname,
        icon,
        createdAt: Date.now(),
        needsReconfirm: false,
      });
      return res.ok;
    },
    /** Drain both timers once, without waiting on them. */
    tick: async () => {
      if (await joinHandle.tick()) void joinerWire();
      await drainAnnouncements(us, announce);
    },
    appRunner: () => appRunner !== null,
  };
}

boot().catch((e) => {
  console.error(e);
  const banner = document.getElementById("banner")!.querySelector(".bar-inner")!;
  banner.textContent = `boot failed: ${err(e)}`;
});
