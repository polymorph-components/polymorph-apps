// Device pairing, end to end, in both ceremonies (PAIRING.md §5, #22
// weight classes).
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
// WHICH DRIVER. This scenario runs against the page's DEFAULT pairing
// backend, the in-page mock (host/pairing-mock.ts) — deterministic, no
// relay, no wasm. That is not a convenience: with `?pairing=engine` the
// real composite traps in `user-create` (a guest panic inside
// wit-bindgen's async support; see host/demo.ts's PAIRING_BACKEND note
// and PAIRING.md §6), so there is no ceremony to drive over the real
// engine yet. The UI, the wiring, the announcements and the
// write-through under test here are the SAME code either way — only the
// object implementing `PairingDriver` differs.

import type { Scenario } from "../run.ts";
import {
  act,
  assert,
  assertEquals,
  assertIncludes,
  hook,
  sleep,
  UI_TIMEOUT,
  waitForBottom,
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

/** The glyph the app guest nominates (wit/todomvc/todomvc.wit's
 * `mark-nomination`, answered in guest-app/src/lib.rs): ♜ U+265C BLACK
 * CHESS ROOK. Pinned so the write-through assertions below are about a
 * specific mark rather than "whatever came out". */
const MARK_ICON = "\u265C";

/** The add sheet's controls, by the words on them — the same way a user
 * finds them. */
const addBtn = (text: string) => `#pair-add-sheet button:has-text(${JSON.stringify(text)})`;

const scenario: Scenario = {
  name: "device-pairing",
  why:
    "the add ceremony is heavy and starts only in visor pixels, the join ceremony is light, both surfaces show the same SAS, the grant is the last act on the granting device, and the account's marks reach the new device",
  run: async (page) => {
    await act("the pairing UI runs against a driver the page names out loud", async () => {
      const backend = await hook(page, "pairing.backend");
      assertEquals(backend, "mock", "the default pairing backend");
      const ready = await hook(page, "pairing.usReady");
      assertEquals(ready, true, "the user-system partition was created at boot");
    });

    let code = "";
    await act("the NEW device shows a 79-character code, grouped for reading", async () => {
      // The tablet's own affordance, clicked for real.
      await page.click("#tablet-join button");
      code = await until(page, "the join pane's code", async () => {
        const c = (await hook(page, "pairing.code")) as string;
        return c.length > 0 ? c : false;
      });
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
      }).then(([a, j]) => {
        assertEquals(a, j, "the SAS on the two surfaces");
        return a;
      });
      // PAIRING.md §2: u32 big-endian mod 10^6, zero-padded — exactly
      // six digits, every time.
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
      const devices = (await hook(page, "pairing.devices")) as unknown[];
      assertEquals(devices.length, 0, "devices enrolled by a premature click");
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

    await act("and the other device's confirm is genuinely CLICKABLE", async () => {
      // A real pointer click, with no `force`: it fails if anything —
      // the dim, a sheet, a stray overlay — covers the button. This is
      // the assertion a hook cannot make.
      await page.click("#tablet-join button:has-text('I initiated')", { timeout: UI_TIMEOUT });
    });

    await act("enrollment is ANNOUNCED on the new device, never silent", async () => {
      await until(page, "the adoption announcement", async () => {
        const st = await page.evaluate(() =>
          document.getElementById("tablet-status")?.textContent ?? ""
        );
        return st.includes("follows your profile") ? st : false;
      });
      await waitForPaneStatus(
        page,
        "tablet",
        (t) => t.includes("follows your profile"),
        "the tablet's adoption announcement",
      );
    });

    await act("the visor's own line announces the device this account gained", async () => {
      // The session ran to completion with NO sheet on screen, and said
      // so on the one surface that cannot be closed.
      await waitForBottom(
        page,
        (t) => t.includes("device added"),
        "the strip's device-added announcement",
      );
    });

    await act("the trusted device records the name the USER typed for it", async () => {
      const devices = (await hook(page, "pairing.devices")) as { name: string }[];
      assertEquals(devices.length, 1, "devices in the account after enrollment");
      assertEquals(devices[0].name, "tablet", "the enrolled device's name");
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
      });
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
  },
};

export default scenario;
