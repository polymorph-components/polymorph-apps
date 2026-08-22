// The device-pairing ceremony, as ACTS — run twice, against two
// different implementations of the same `PairingDriver` seam.
//
// WHY THIS MODULE EXISTS. The suite makes exactly one argument about
// pairing (see either scenario's header for it), and that argument is
// about the visor's UI, its weight classes and its write-through — none
// of which is a claim about a transport. So the acts live here ONCE and
// are parameterized only where the two backends GENUINELY differ:
//
//   - the backend name the page announces (`pairing.backend`), because a
//     scenario that did not check would happily pass against the wrong
//     one and prove nothing about the driver it names in its title;
//   - the CONVERGENCE DEADLINES. The mock's "network" is an in-page
//     object: every step of a ceremony is done by the time the call
//     returns. The engine's is iroh over a relay, an ENROLL that has to
//     cross it, and — for the marks beat — a post-enrollment subduction
//     the embedder wires after the join completes (host/demo.ts's
//     `wireUsSubduction`). Nothing here assumes an instant answer any
//     more: every cross-device claim goes through the `until` idiom with
//     a deadline the slow path can actually meet.
//
// The SAS is six digits either way — that is PAIRING.md §2's rule about
// the value, not about the transport — so it is asserted identically.

import {
  act,
  assert,
  assertEquals,
  assertIncludes,
  hook,
  sleep,
  UI_TIMEOUT,
  recordSurfaceLine,
  waitForDrawerHidden,
  waitForPaneStatus,
} from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

/** Poll the demo's own single-shot drain until `f` is satisfied. The
 * page has its own timers for all of this; the scenario drives the
 * drain itself so a slow machine cannot turn a real assertion into a
 * flake. */
async function until<T>(
  page: Page,
  what: string,
  f: () => Promise<T | false>,
  timeout = UI_TIMEOUT,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown = undefined;
  while (Date.now() < deadline) {
    await hook(page, "pairing.tick");
    const v = await f();
    if (v !== false) return v;
    last = v;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** The glyph the app guest nominates (examples/todomvc/wit/todomvc.wit's
 * `mark-nomination`, answered in guest-app/src/lib.rs): ♜ U+265C BLACK
 * CHESS ROOK. Pinned so the write-through assertions below are about a
 * specific mark rather than "whatever came out". */
const MARK_ICON = "\u265C";

/** The add sheet's controls, by the words on them — the same way a user
 * finds them. */
const addBtn = (text: string) => `#pair-add-sheet button:has-text(${JSON.stringify(text)})`;

/** How long each cross-device step may take before it counts as broken.
 * The mock's are the UI's own timings; the engine's are generous on
 * purpose — a deadline that is merely "usually enough" is a flake
 * generator, and the failure it would report ("the SAS never appeared")
 * is the same one a real break reports. */
export interface PairingWaits {
  /** The join pane rendering its offer code. */
  code: number;
  /** Both surfaces showing the SAS: the add side has to claim the offer
   * over the transport first. */
  sas: number;
  /** ENROLL landing on the joining device, and its adoption
   * announcement. */
  enroll: number;
  /** The account's device list on the granting device. */
  devices: number;
  /** A mark written on the laptop showing up on the tablet — the whole
   * write-through path, including the post-enrollment sync. */
  marks: number;
}

export const MOCK_WAITS: PairingWaits = {
  code: UI_TIMEOUT,
  sas: UI_TIMEOUT,
  enroll: UI_TIMEOUT,
  devices: UI_TIMEOUT,
  marks: UI_TIMEOUT,
};

export const ENGINE_WAITS: PairingWaits = {
  code: 30_000,
  sas: 60_000,
  enroll: 60_000,
  devices: 30_000,
  marks: 60_000,
};

export interface PairingActsOptions {
  /** What `pairing.backend` must answer — the driver this run is about. */
  backend: "mock" | "engine";
  waits: PairingWaits;
}

export async function runPairingActs(page: Page, opts: PairingActsOptions): Promise<void> {
  const { backend, waits } = opts;
  /** How many devices this account already lists before the ceremony
   * starts. NOT zero on the engine path, and that is correct: a real
   * `user-create` records the FOUNDING device in the user-system doc
   * with an empty name (engine/guest/src/usdoc.rs:599 — "a missing first
   * device would be worse than an unnamed one"), while the in-page mock
   * models only the peers a ceremony enrolled. So the acts below assert
   * the DELTA and the NAME rather than an absolute count: what the
   * ceremony claims is that a premature click enrolls nothing and a
   * completed grant enrolls exactly the device the user named. */
  let devicesAtStart = 0;
  const devices = async () => (await hook(page, "pairing.devices")) as { name: string }[];

  await act("the pairing UI runs against a driver the page names out loud", async () => {
    const named = await hook(page, "pairing.backend");
    assertEquals(named, backend, "the pairing backend this run is about");
    // The user system is created at boot on the owner pane. On the
    // engine path that is a real `user-create` through the composite —
    // the call that used to trap (PAIRING.md §6) — so this act is also
    // the regression guard on polyengine#213.
    const ready = await until(
      page,
      "the user-system partition",
      async () => (await hook(page, "pairing.usReady")) === true || false,
      waits.code,
    );
    assertEquals(ready, true, "the user-system partition was created at boot");
    devicesAtStart = (await devices()).length;
    assertEquals(
      (await devices()).filter((d) => d.name === "tablet").length,
      0,
      "devices named 'tablet' before the ceremony",
    );
  });

  let code = "";
  await act("the NEW device shows a 79-character code, grouped for reading", async () => {
    // The tablet's own affordance, clicked for real.
    await page.click("#tablet-join button");
    code = await until(page, "the join pane's code", async () => {
      const c = (await hook(page, "pairing.code")) as string;
      return c.length > 0 ? c : false;
    }, waits.code);
    assertEquals(code.length, 79, "the pairing code's length (PAIRING.md §1)");
    // Grouped by 4 on screen; the hook strips the grouping, so read
    // the rendered text for the grouping claim itself.
    const rendered = await page.evaluate(() =>
      document.querySelector("#tablet-join .pm-code")?.textContent ?? ""
    );
    assertIncludes(rendered, " ", "the rendered code is grouped");
    assertEquals(
      rendered.split(" ")[0].length,
      4,
      "the first group's length (display in groups of 4)",
    );
  });

  await act("the ADD ceremony is reachable only from the visor's own sheet", async () => {
    const beforeOpen = await hook(page, "pairing.addOpen");
    assertEquals(beforeOpen, false, "the add sheet before anything is clicked");
    // Two real clicks, both on visor pixels: the strip's own button,
    // then the action the visor drew on its own sheet.
    await page.click("#visor-settings");
    await page.click('#visor-drawer-inner .settings-extra-action[data-action="add-device"]');
    const open = await hook(page, "pairing.addOpen");
    assertEquals(open, true, "the add sheet after the settings action");
    // The same control must not exist inside a component frame — a
    // rectangle that could draw it could start a grant of admin over
    // the whole account.
    const inFrame = await page.evaluate(() =>
      document.querySelectorAll('iframe [data-action="add-device"]').length
    );
    assertEquals(inFrame, 0, "an add-a-device control inside a component frame");
  });

  let sas = "";
  await act("the SAME six digits are rendered on BOTH surfaces", async () => {
    // The code moving between the two devices is the one step a
    // one-page demo cannot mime with a pointer (a user reads it off
    // one screen and types it into another), so it goes through the
    // page's own transfer hook. Everything around it is a real
    // gesture: the field is filled and the button is clicked.
    const pasted = await hook(page, "pairing.pasteCode", code);
    assertEquals(pasted, true, "the code went into the add sheet's field");
    await page.click(addBtn("connect"));
    sas = await until(page, "a SAS on both surfaces", async () => {
      const a = (await hook(page, "pairing.sasAdd")) as string;
      const j = (await hook(page, "pairing.sasJoin")) as string;
      return a !== "" && j !== "" ? [a, j] as [string, string] : false;
    }, waits.sas).then(([a, j]) => {
      assertEquals(a, j, "the SAS on the two surfaces");
      return a;
    });
    // PAIRING.md §2: u32 big-endian mod 10^6, zero-padded — exactly
    // six digits, every time. True of both backends: it is a statement
    // about the value, not about how it got there.
    assert(/^\d{6}$/.test(sas), `the SAS is six decimal digits (got ${sas.length} chars)`);
  });

  await act("the HEAVY ceremony states the consequence before it arms", async () => {
    await page.click(addBtn("codes match"));
    const consequence = (await hook(page, "pairing.consequence")) as string;
    assertIncludes(
      consequence,
      "full access to everything in your account",
      "the statement of consequence",
    );
    const armed = await hook(page, "pairing.grantArmed");
    assertEquals(armed, false, "the grant button before the arming delay elapses");
  });

  await act("the device name starts EMPTY — never prefilled by the other side", async () => {
    const name = await page.inputValue("#pair-add-sheet input[type=text]");
    assertEquals(name, "", "the device-name field at first paint");
  });

  await act("a click before the delay elapses grants nothing", async () => {
    // A real user CANNOT click this: the button is disabled, and
    // Playwright's actionability check refuses it exactly as a pointer
    // would. `force` bypasses that to reach the handler underneath —
    // which refuses on its own account (defence in depth), and is the
    // half a disabled attribute cannot promise.
    await page.click("#pair-add-sheet button.pm-armed", { force: true }).catch(() => {});
    await sleep(50);
    const stillArming = await hook(page, "pairing.grantArmed");
    assertEquals(stillArming, false, "the grant button right after a premature click");
    assertEquals(
      (await devices()).length,
      devicesAtStart,
      "devices in the account after a premature click (nothing was enrolled)",
    );
  });

  await act("the ceremony cannot be slid out from under the user", async () => {
    // The add sheet is an EXCLUSIVE tenant: while a device is being
    // granted admin over the account, a click on the strip must not
    // be able to put another sheet over it. (The same rule the
    // credential sheet has, for the same reason — see
    // tenant-precedence.) The strip is under the dim, so this one is
    // driven through the hook: what is under test is the refusal, not
    // whether the dim covers the strip.
    await hook(page, "naming.openCluster");
    const naming = await hook(page, "naming.open");
    assertEquals(naming, false, "the naming sheet opened over the grant ceremony");
    const stillAdd = await hook(page, "pairing.addOpen");
    assertEquals(stillAdd, true, "the add sheet after a strip click");
  });

  await act("after the delay, the named grant goes through", async () => {
    // Real typing, then a real click. Playwright waits for the button
    // to become enabled — i.e. it waits out the arming delay the same
    // way a user does.
    await page.fill("#pair-add-sheet input[type=text]", "tablet");
    await page.click("#pair-add-sheet button.pm-armed", { timeout: UI_TIMEOUT });
  });

  await act("the grant is the LAST act on this device — the sheet comes down", async () => {
    // THE REGRESSION THIS SCENARIO EXISTS FOR. Until the sheet closes,
    // the dim covers the other device and the ceremony cannot be
    // finished by a human at all: the grant waits on a confirm the dim
    // makes unclickable.
    const open = await hook(page, "pairing.addOpen");
    assertEquals(open, false, "the add sheet after the grant");
    const dimUp = await page.evaluate(() =>
      (document.getElementById("visor-dim") as HTMLElement | null)?.hidden === false
    );
    assertEquals(dimUp, false, "the page dim after the grant");
    await waitForDrawerHidden(page);
  });

  // FROM HERE ON, RECORD THE STRIP rather than sample it. Two
  // announcements land within a second of each other at the end of a
  // ceremony — the joining device's adoption line and the granting
  // device's "device added" — and `visor.announce` REPLACES: the second
  // one takes the bottom line and the first is gone. Which arrives
  // first is a property of the transport (the mock resolves both in the
  // same turn; over iroh the joiner's tends to land first), so a
  // sampling wait on either one is a race by construction. The recorder
  // catches every value the line took, including one that was on screen
  // for a single frame.
  const strip = await recordSurfaceLine(page);

  await act("and the other device's confirm is genuinely CLICKABLE", async () => {
    // A real pointer click, with no `force`: it fails if anything —
    // the dim, a sheet, a stray overlay — covers the button. This is
    // the assertion a hook cannot make.
    await page.click("#tablet-join button:has-text('I initiated')", { timeout: UI_TIMEOUT });
  });

  await act("enrollment is ANNOUNCED on the new device, never silent", async () => {
    // On the engine path the ENROLL card has to cross the transport
    // before the join pane can say anything, so the wait is the
    // ceremony's, not the UI's.
    await until(page, "the adoption announcement", async () => {
      const st = await page.evaluate(() =>
        document.getElementById("tablet-status")?.textContent ?? ""
      );
      return st.includes("follows your profile") ? st : false;
    }, waits.enroll);
    await waitForPaneStatus(
      page,
      "tablet",
      (t) => t.includes("follows your profile"),
      "the tablet's adoption announcement",
      waits.enroll,
    );
  });

  await act("the visor's own line announces the device this account gained", async () => {
    // The session ran to completion with NO sheet on screen, and said
    // so on the one surface that cannot be closed.
    await until(page, "the strip's device-added announcement", async () => {
      const seen = await strip.samples();
      return seen.some((t) => t.includes("device added")) ? seen : false;
    }, waits.enroll);
    await strip.stop();
  });

  await act("the trusted device records the name the USER typed for it", async () => {
    const named = await until(page, "the enrolled device", async () => {
      const ds = (await devices()).filter((d) => d.name === "tablet");
      return ds.length > 0 ? ds : false;
    }, waits.devices);
    assertEquals(named.length, 1, "devices carrying the name the user typed");
    assertEquals(
      (await devices()).length,
      devicesAtStart + 1,
      "devices in the account after enrollment (exactly one was added)",
    );
  });

  await act("naming a component on the laptop reaches the newly joined device", async () => {
    // The whole point of §5's demotion: the user's own word for a
    // component is ACCOUNT state now, not device state. So this act
    // drives the REAL naming ceremony — the strip's own cluster, the
    // sheet, the Save, all real gestures — and then looks for the
    // result on the OTHER device. What is under test is the
    // write-through (`onNamed` -> `us-mark-put`), not a test hook that
    // writes marks directly; localStorage is still written exactly as
    // before, but it is the boot cache now.
    //
    // On the engine path this is the act the post-enrollment
    // subduction exists for: the mark is written into alice's
    // user-system doc and has to REACH the tablet's replica.
    await page.click("#visor-context");
    await page.waitForFunction(
      // deno-lint-ignore no-explicit-any
      () => (globalThis as any).__demo.naming.open() === true,
      undefined,
      { timeout: UI_TIMEOUT },
    );
    await page.fill("#visor-drawer-inner .name-sheet input", "Tasks");
    // A MARK GOES WITH THE NAME. The app nominates ♜ (its own WIT
    // `mark-nomination`), the ceremony offers it first, and adopting it
    // is a real click on the picker — so what crosses to the other
    // device below is a petname AND a pet icon, which is the whole
    // schema change (#22 discussion: `us-mark.hue` -> `us-mark.icon`).
    const adopted = await page.evaluate(() => {
      const b = document.querySelector(
        '#visor-drawer-inner .name-sheet .name-icons button[data-nominated="true"]',
      ) as HTMLButtonElement | null;
      b?.click();
      return b?.dataset.glyph ?? "";
    });
    assertEquals(adopted, MARK_ICON, "the mark adopted on the laptop");
    await page.click("#visor-drawer-inner .name-sheet .cred-row button:first-child");
    const marks = await until(page, "the mark on the tablet", async () => {
      const ms = (await hook(page, "pairing.marks")) as { provenance: string }[] | {
        error: boolean;
      };
      if (!Array.isArray(ms)) return false;
      return ms.some((m) => m.provenance === "app") ? ms : false;
    }, waits.marks);
    const mark = (marks as { provenance: string; petname: string; icon: string }[]).find((m) =>
      m.provenance === "app"
    )!;
    assertEquals(mark.petname, "Tasks", "the petname the tablet sees");
    // The GLYPH ITSELF crosses, not an index into a palette: the
    // partition holds it opaquely and repairs collisions on exact
    // equality, and the vocabulary stays the visor's.
    assertEquals(mark.icon, MARK_ICON, "the pet icon the tablet sees");
    // And the boot cache still holds it too — the demotion changed
    // which copy is authoritative, not which copies exist.
    const cached = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("pm-demo-surface-marks") ?? "{}")
    ) as Record<string, { petname?: string; icon?: string }>;
    assertEquals(cached["app"]?.petname, "Tasks", "the petname in the boot cache");
    assertEquals(cached["app"]?.icon, MARK_ICON, "the pet icon in the boot cache");
  });
}

/** The claim BOTH runs make, so the two scenarios cannot drift apart in
 * what they say they are proving. */
export const PAIRING_WHY =
  "the add ceremony is heavy and starts only in visor pixels, the join ceremony is light, both surfaces show the same SAS, the grant is the last act on the granting device, and the account's marks reach the new device";
