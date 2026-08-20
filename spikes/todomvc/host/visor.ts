// TodoMVC's own consumption of the visor's shared system-UI core
// (visor/ui/visor.ts): the strip, the identity cluster, the context
// cluster and the drawer host are the framework's; what stays here is
// this page's OWN storage keys, its one static app-surface record (there
// is exactly one artifact, so there is exactly one row in the trust
// table — no naming ceremony, no per-mark palette assignment the way the
// demo spike needs for its three panes), and the two lightweight drawer
// tenants this page has always had: "consent" and "kill", ported from
// the pre-shared-core spike (`git show HEAD:spikes/todomvc/host/
// visor.ts`, before this file became a from-scratch consumer of
// visor/ui/visor.ts — C3 of the visor extraction) with their exact
// user-facing strings and semantics preserved.

import {
  initVisor,
  type SurfaceIdentity,
  VISOR_HUES,
} from "../../../visor/ui/visor.ts";
import type { Runner } from "./app.ts";

// --- this page's own storage keys ---------------------------------------------
//
// Two spikes on one origin must not share an anchor colour or an
// identity record: the palette and the identity vocabulary are the
// framework's (visor/ui/visor.ts), the KEYS are the consumer's. No
// legacy key here — todomvc never had a pre-rename ("chrome") key to
// migrate, unlike the demo spike's #22 migration.
const HUE_KEY = "pm-todomvc-visor-hue";
const IDENTITY_KEY = "pm-todomvc-identity";

/** The component tint for the strip's top-line chip: deterministic from
 * the artifact name, never random and never user-chosen — this is the
 * SAME derivation the demo spike explicitly rejected for its own trust
 * marks (see host/demo.ts's `surfaceMark` comment: deriving the
 * assigned-mark colour from component bytes lets an impersonator grind
 * its artifact for a collision). It is safe here for the reason that
 * comment gives: todomvc has exactly ONE artifact per boot, assigned
 * once at compile/serve time, not attacker-choosable at runtime the way
 * a mark record's key is — there is no target color to grind toward,
 * only "this app" vs. "some other app", and the palette is small and
 * fixed either way. Spike-grade, documented per the dispatch. */
function tintFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return VISOR_HUES[h % VISOR_HUES.length];
}

export interface Visor {
  /** Hand the visor the running app: the runner the "consent"/"kill"
   * tenants pause/resume, and the frame surface's own teardown (present
   * only for `kind === "frame"` — see app.ts's TodoApp.teardown), which
   * "kill" awaits before it replaces the app host with the killed note. */
  bind(app: { runner: Runner; teardown?: () => Promise<void> }): void;
  readonly killed: boolean;
}

export function initTodoVisor(artifactName: string): Visor {
  let bound: { runner: Runner; teardown?: () => Promise<void> } | null = null;
  let killed = false;

  const appSurface: SurfaceIdentity = {
    name: artifactName,
    // The guest declares nothing about itself here — there is no
    // separate self-description surface in this spike, unlike the
    // demo's panel `nickname()` export.
    nickname: "",
    hue: tintFor(artifactName),
    isNew: false,
    // The page's own historical user-facing word (pre-C3 `initVisor("TodoMVC", ...)`),
    // carried over as the assigned petname rather than re-litigated
    // through a naming ceremony this page does not otherwise offer.
    petname: "TodoMVC",
  };

  const visor = initVisor({
    hueKey: HUE_KEY,
    identityKey: IDENTITY_KEY,
    appSurface: () => appSurface,
  });

  // A silently-reset anchor trains the user that it changes sometimes;
  // a reset is therefore announced, on the visor's own line — identical
  // wording to the demo spike's boot announcement (host/demo.ts:1128),
  // because it is the same event under the same rule.
  if (visor.fresh) {
    visor.announce("new visor colour set for this device — remember it", 15000);
  }

  // The context is rendered once at construction (initVisor's own
  // `setContext(null)` already resolves through `appSurface` above); no
  // further boot-time render is needed before the strip is live.
  visor.renderContext();

  // --- this page's own strip controls --------------------------------------
  //
  // Mounted into the shared core's optional actions slot
  // (visor/ui/visor.ts's Visor.actions) — absent for the demo spike's
  // markup, present here (web/index.html's #visor-actions). Two buttons,
  // same as the pre-C3 strip: "consent demo" and "kill".
  const consentBtn = document.createElement("button");
  consentBtn.type = "button";
  consentBtn.textContent = "consent demo";
  const killBtn = document.createElement("button");
  killBtn.type = "button";
  killBtn.textContent = "kill";
  visor.actions?.append(consentBtn, killBtn);

  // --- the "consent" tenant -------------------------------------------------
  //
  // A simulated consent prompt: armed (Allow/Deny stay disabled until the
  // arming delay elapses — defeats a baited mis-tap) and dimmed (the app
  // is paused for the duration, so it can neither observe nor race the
  // decision). Ported verbatim in wording from the pre-C3 spike's
  // `consentContent`.
  const consentTenant = visor.drawer.tenant<{ appName: string }>({
    name: "consent",
    armed: true,
    dim: true,
    context: () => ({ ...appSurface, kind: "panel" }),
    beforeShow: () => {
      bound?.runner.pause();
    },
    afterCollapse: () => {
      if (!killed) bound?.runner.resume();
    },
  });

  function buildConsentSheet(appName: string) {
    const root = document.createElement("div");
    root.className = "todomvc-sheet";
    const h = document.createElement("h2");
    h.textContent = "Simulated consent prompt";
    const p = document.createElement("p");
    // Untrusted-string discipline: app-supplied text is quoted and
    // styled as foreign, never part of the visor's own sentence.
    p.append("The app ");
    const q = document.createElement("q");
    q.className = "tm-foreign";
    q.textContent = appName;
    p.append(
      q,
      " requests a demonstration capability. While this surface is open, the app receives no input.",
    );
    const note = document.createElement("p");
    note.className = "tm-note";
    note.textContent =
      "Controls arm only after the reveal completes. The visor never asks you to type a secret here.";
    const row = document.createElement("div");
    row.className = "tm-row";
    const allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = "Allow";
    const deny = document.createElement("button");
    deny.type = "button";
    deny.textContent = "Deny";
    allow.onclick = () => consentTenant.close();
    deny.onclick = () => consentTenant.close();
    row.append(allow, deny);
    root.append(h, p, note, row);
    return { root, controls: [allow, deny] };
  }

  consentBtn.onclick = () => {
    consentTenant.open({ appName: artifactName }, (s) => buildConsentSheet(s.appName));
  };

  // --- the "kill" tenant ------------------------------------------------------
  //
  // "Suspend this app?", same armed+dimmed sheet shape. On Suspend (the
  // NEW, now-real part of C3): close the sheet, mark killed, pause the
  // runner FOR GOOD (never resumed — see `afterCollapse` above's
  // `!killed` guard), await the frame surface's own teardown when there
  // is one, and only then replace the app host's content with the
  // `.visor-killed` note. Awaiting first means a `kind=frame` app's
  // sandboxed iframe is actually gone — not merely marked dead — before
  // the note claims it is.
  const killTenant = visor.drawer.tenant<Record<never, never>>({
    name: "kill",
    armed: true,
    dim: true,
    context: () => ({ ...appSurface, kind: "panel" }),
    beforeShow: () => {
      bound?.runner.pause();
    },
    afterCollapse: () => {
      if (!killed) bound?.runner.resume();
    },
  });

  function buildKillSheet() {
    const root = document.createElement("div");
    root.className = "todomvc-sheet";
    const h = document.createElement("h2");
    h.textContent = "Suspend this app?";
    const p = document.createElement("p");
    p.textContent =
      "Input delivery stops and the app's surface is removed. (Spike semantics; real teardown is a deltic embedder-API question — #22.)";
    const row = document.createElement("div");
    row.className = "tm-row";
    const suspend = document.createElement("button");
    suspend.type = "button";
    suspend.textContent = "Suspend";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    suspend.onclick = () => {
      killTenant.close();
      killed = true;
      bound?.runner.pause(); // never resumed: delivery stops for good
      const finish = () => {
        const appHost = document.getElementById("app") as HTMLElement | null;
        const note = document.createElement("div");
        note.className = "visor-killed";
        note.textContent = "App suspended by user.";
        appHost?.replaceChildren(note);
      };
      // The frame surface (if any) is torn down before the host content
      // is replaced: awaiting `teardown()` means the sandboxed iframe is
      // actually gone, not merely superseded, before the note claims the
      // app is.
      const teardown = bound?.teardown;
      if (teardown) {
        teardown().then(finish);
      } else {
        finish();
      }
    };
    cancel.onclick = () => killTenant.close();
    row.append(suspend, cancel);
    root.append(h, p, row);
    return { root, controls: [suspend, cancel] };
  }

  killBtn.onclick = () => {
    killTenant.open({}, () => buildKillSheet());
  };

  return {
    bind(app) {
      bound = app;
    },
    get killed() {
      return killed;
    },
  };
}
