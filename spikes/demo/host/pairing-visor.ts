// Visor-owned pairing + user-system UI (Track B; PAIRING.md §5, #22
// rulings). This is THE module that may render a pairing code or a SAS
// — scripts/check-invariants.sh greps for that property, so a
// refactor that moves this rendering elsewhere must move the grep
// marker too (documented at the marker, below).
//
// Everything in this file is visor pixels: no component frame imports
// it, and it never crosses the frame seam (same discipline as the
// petname/identity code in host/demo.ts — see check-invariants.sh (a)
// and (e), which this file's new check (f) extends).
//
// #22 rulings this file must keep, restated so a future edit here has
// them to hand:
//   - announced-never-silent: a recognition/identity change caused by
//     something OTHER than the user's own action in THIS pane (a
//     remote write) is always announced, never quietly applied.
//   - three names, whose voice: the device name in the ADD ceremony is
//     the visor's voice because the user typed it — never prefilled from
//     a string the joiner or the peer sent.
//   - ceremony weight classes: the ADD ceremony is heavy (consequential
//     grant: the new device becomes admin of everything) and reuses the
//     arming-delay mechanism from host/demo.ts's credential drawer. The
//     JOIN ceremony's local confirm is light (nothing secret is typed;
//     the worst mis-tap outcome is a cancelled join) and must stay
//     light — no arming tax on it.
//   - status/rule-line priority over ambient telemetry: announcements
//     use the same STICKY pattern as host/demo.ts's beat statuses.

import { QrCode } from "./vendor/qrcodegen.ts";
import type {
  PairingDriver,
  UsDevice,
  UsEvent,
  UsMark,
  UsProfile,
} from "./pairing-mock.ts";

// --- the palette: index -> OKLCH angle (PAIRING.md §4) ---------------------
//
// `us-profile.hue` / `us-mark.hue` are PALETTE INDICES (u16, 0-9), not
// raw angles — the engine only ever compares/stores indices, and the
// angle is purely a visor rendering choice. This mirrors host/demo.ts's
// VISOR_HUES array exactly (host/demo.ts:112 — read-only reference,
// never imported: that file's array is the pre-partition, device-local
// palette this migration is retiring, and the two must simply agree on
// values, not share code).
const PALETTE: readonly number[] = [265, 210, 175, 140, 95, 60, 35, 10, 330, 300];

/** Index -> displayable OKLCH angle. Out-of-range indices (a palette
 * bigger than this visor build knows about) fall back to the first
 * entry rather than producing an invalid colour. */
export function paletteAngle(index: number): number {
  return PALETTE[index] ?? PALETTE[0];
}

// --- THE GREP MARKER (invariant (f), scripts/check-invariants.sh) ---------
//
// Both a pairing CODE and a SAS are rendered ONLY through the two
// functions below. The invariant script asserts that the literal
// substrings "renderPairingCode(" and "renderSas(" appear ONLY in this
// file (never in host/frame.ts, host/frame-backend.ts, web/frame.html,
// or any guest-*/**). That is a stronger, cheaper property than trying
// to grep the word "SAS" itself (which would also fire on comments
// elsewhere): it pins the RENDERING CALL SITE, and a component frame
// has no way to reach a host-side function call at all, so the
// existence of the call outside this file would mean the architecture
// itself had grown a new seam-crossing path — exactly the shape of bug
// invariant (a) already guards for the petname.
function renderPairingCode(code: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "pm-code";
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += 4) groups.push(code.slice(i, i + 4));
  wrap.textContent = groups.join(" ");
  return wrap;
}

function renderSas(sas: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pm-sas";
  el.textContent = sas;
  return el;
}

// --- shared styling (injected once) ----------------------------------------

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .pm-pane { border: 1px solid #ccc; border-radius: 6px; padding: .8em;
      font: 13px/1.4 'Helvetica Neue', Helvetica, Arial, sans-serif; }
    .pm-code { font: 20px/1.4 ui-monospace, monospace; letter-spacing: .04em;
      word-break: break-all; margin: .5em 0; }
    .pm-sas { font: 28px/1.2 ui-monospace, monospace; letter-spacing: .1em;
      margin: .5em 0; }
    .pm-qr { image-rendering: pixelated; border: 1px solid #999; }
    .pm-status { min-height: 1.4em; font-weight: 600; }
    .pm-status.pm-consequential { color: #7a3b00; }
    .pm-consequence { background: #fff3cd; border: 1px solid #e0b23c;
      border-radius: 4px; padding: .6em; margin: .5em 0; }
    .pm-devices { list-style: none; padding: 0; margin: .3em 0; }
    .pm-devices li { padding: .2em 0; border-bottom: 1px solid #eee; }
    .pm-armed[disabled] { opacity: .5; cursor: not-allowed; }
    .pm-hue-swatch { display: inline-block; width: .9em; height: .9em;
      border-radius: 2px; vertical-align: -1px; margin-right: .3em;
      border: 1px solid rgba(0,0,0,.3); }
  `;
  document.head.appendChild(style);
}

// --- QR rendering (data-URL, per §5) ---------------------------------------

/** Render `text` as a QR data-URL. Vendored self-contained encoder (see
 * host/vendor/qrcodegen.ts) — no new dependency for one image. */
function qrDataUrl(text: string, scale = 4): string {
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const size = qr.size;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.getModule(x, y)) ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return canvas.toDataURL("image/png");
}

// --- announcements: drained us-events, priority over ambient ticks --------

/** Same shape as host/demo.ts's beat-status stickiness (STICKY_MS):
 * a consequential, one-shot announcement must not be erased by an
 * ambient tick within its window. Each pane gets its own sticky-until
 * clock, keyed by the status element's id. */
const STICKY_MS = 12_000;
const stickyUntil = new Map<string, number>();

export function statusWriter(el: HTMLElement, key: string): (line: string, sticky?: boolean) => void {
  return (line, sticky = false) => {
    if (!sticky && (stickyUntil.get(key) ?? 0) > performance.now()) return;
    if (sticky) {
      stickyUntil.set(key, performance.now() + STICKY_MS);
      el.classList.add("pm-consequential");
    } else {
      el.classList.remove("pm-consequential");
    }
    el.textContent = line;
  };
}

function describeEvent(ev: UsEvent): string {
  switch (ev.tag) {
    case "profile-changed":
      return "profile updated on another device";
    case "mark-added":
      return `new trust record: ${ev.provenance}`;
    case "mark-changed":
      return `trust record changed: ${ev.provenance}`;
    case "mark-conflict-repaired":
      return ev.field === "petname"
        ? `NEW — a naming conflict was found and repaired for ${ev.provenance} (re-confirm its name)`
        : `a colour conflict was found and repaired for ${ev.provenance}`;
    case "device-added":
      return `device added: ${ev.name || "(unnamed)"}`;
    case "device-revoked":
      return `device revoked: ${ev.name || "(unnamed)"}`;
  }
}

/** Drain `us-events` and announce every one — announced-never-silent,
 * per PAIRING.md §5. `mark-conflict-repaired` for a petname collision
 * is rendered as a sticky NEW-with-explanation (the contract's
 * "needs-reconfirm... renders as NEW-with-explanation at next mount");
 * `device-added`/`device-revoked`/`profile-changed` are also
 * consequential (sticky) — an ambient tick must not erase them. */
export async function drainAnnouncements(
  driver: PairingDriver,
  status: (line: string, sticky?: boolean) => void,
): Promise<UsEvent[]> {
  const res = await driver.usEvents();
  if (!res.ok) return [];
  for (const ev of res.value) status(describeEvent(ev), true);
  return res.value;
}

// --- boot cache: hue / display-name / marks, demoted from source of truth --

const HUE_CACHE_KEY = "pm-demo-us-hue-cache";
const NAME_CACHE_KEY = "pm-demo-us-name-cache";
const MARKS_CACHE_KEY = "pm-demo-us-marks-cache";

export interface BootCache {
  /** A palette INDEX (see `paletteAngle`/`PALETTE`, above), not an angle. */
  hue?: number;
  displayName?: string;
  marks?: UsMark[];
}

/** Render-from-cache, per §5: localStorage is a BOOT CACHE now, not the
 * source of truth (the us-* partition is). Reconciliation happens once
 * the driver is up (see `reconcileFromDriver`); this only lets the visor
 * paint something before that completes instead of a blank frame. */
export function loadBootCache(): BootCache {
  try {
    const hueRaw = localStorage.getItem(HUE_CACHE_KEY);
    const nameRaw = localStorage.getItem(NAME_CACHE_KEY);
    const marksRaw = localStorage.getItem(MARKS_CACHE_KEY);
    return {
      hue: hueRaw !== null ? Number(hueRaw) : undefined,
      displayName: nameRaw ?? undefined,
      marks: marksRaw ? JSON.parse(marksRaw) : undefined,
    };
  } catch {
    return {};
  }
}

function saveBootCache(cache: BootCache) {
  try {
    if (cache.hue !== undefined) localStorage.setItem(HUE_CACHE_KEY, String(cache.hue));
    if (cache.displayName !== undefined) localStorage.setItem(NAME_CACHE_KEY, cache.displayName);
    if (cache.marks !== undefined) localStorage.setItem(MARKS_CACHE_KEY, JSON.stringify(cache.marks));
  } catch { /* nothing durable to write to */ }
}

/** After driver init: pull the real profile + marks, compare against
 * the boot cache, ANNOUNCE any diff (a silently-changed hue/name is
 * exactly the "anchor that quietly changes" lesson from #22 the
 * visor-hue code already carries), then refresh the cache to match. */
export async function reconcileFromDriver(
  driver: PairingDriver,
  status: (line: string, sticky?: boolean) => void,
  onProfile?: (profile: UsProfile) => void,
): Promise<void> {
  const cache = loadBootCache();
  const profileRes = await driver.usProfileGet();
  if (profileRes.ok) {
    const p = profileRes.value;
    if (cache.hue !== undefined && cache.hue !== p.hue) {
      status(`your colour changed to match your account (was device-local)`, true);
    }
    if (cache.displayName !== undefined && cache.displayName !== p.displayName) {
      status(`your name is now "${p.displayName}" (synced from your account)`, true);
    }
    saveBootCache({ hue: p.hue, displayName: p.displayName });
    onProfile?.(p);
  }
  const marksRes = await driver.usMarksList();
  if (marksRes.ok) saveBootCache({ marks: marksRes.value });
}

// --- join flow: new device (§5) --------------------------------------------

export interface JoinPaneHandle {
  /** Poll once; call on an interval from the host page. Returns true
   * once enrollment completes (caller may stop polling). */
  tick(): Promise<boolean>;
}

/** Mounts the join flow into `container`: entry button → QR + grouped
 * code → SAS screen → light confirm → adoption announcement. `onAdopt`
 * fires once with the synced profile so the host page can repaint the
 * pane's visor hue — the "hue visibly changing to the synced one"
 * beat lives in the CALLER because the caller owns the pane's actual
 * strip element; this module only reports the value. `profile.hue` is
 * a PALETTE INDEX (see `paletteAngle`) — the caller converts it to an
 * angle when painting. */
export function mountJoinPane(
  container: HTMLElement,
  driver: PairingDriver,
  status: (line: string, sticky?: boolean) => void,
  onAdopt: (profile: { hue: number; displayName: string }) => void,
): JoinPaneHandle {
  ensureStyles();
  container.classList.add("pm-pane");
  container.replaceChildren();

  let phase: "entry" | "waiting" | "sas" | "confirmed" | "done" | "failed" = "entry";
  let code: string | undefined;
  let confirmed = false;

  const entryBtn = document.createElement("button");
  entryBtn.textContent = "join existing account";
  container.appendChild(entryBtn);

  const body = document.createElement("div");
  container.appendChild(body);

  entryBtn.onclick = async () => {
    const res = await driver.pairJoinStart();
    if (!res.ok) {
      status(`could not start join: ${res.error}`, true);
      return;
    }
    code = res.value.code;
    phase = "waiting";
    entryBtn.hidden = true;
    body.replaceChildren();
    const qrImg = document.createElement("img");
    qrImg.className = "pm-qr";
    qrImg.width = 132;
    qrImg.height = 132;
    qrImg.alt = "pairing QR code";
    qrImg.src = qrDataUrl(code);
    const label = document.createElement("div");
    label.textContent = "on your trusted device: add a device, then enter this code";
    body.append(qrImg, renderPairingCode(code), label);
    status("waiting for the other device…");
  };

  const renderSasScreen = (sas: string) => {
    phase = "sas";
    body.replaceChildren();
    const label = document.createElement("div");
    label.textContent = "confirm this code matches the other device:";
    const sasEl = renderSas(sas);
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "I initiated this — codes match";
    // LIGHT ceremony (PAIRING.md §5 + #22 weight classes): nothing
    // secret is typed here and the gesture starts from a button this
    // pane's own visor drew, so no arming delay — see the file-header
    // note on ceremony weight classes.
    confirmBtn.onclick = async () => {
      if (confirmed) return;
      confirmed = true;
      confirmBtn.disabled = true;
      await driver.pairJoinConfirm();
      phase = "confirmed";
      status("confirmed — waiting for the other device to confirm…");
    };
    body.append(label, sasEl, confirmBtn);
  };

  const handle: JoinPaneHandle = {
    async tick() {
      if (!code || phase === "done" || phase === "failed") return phase === "done";
      const res = await driver.pairJoinStatus();
      if (!res.ok) return false;
      const st = res.value;
      if (st.tag === "claimed" && phase === "waiting") {
        renderSasScreen(st.sas);
      } else if (st.tag === "confirmed-waiting" && phase !== "confirmed") {
        phase = "confirmed";
        status("confirmed — waiting for the other device to confirm…");
      } else if (st.tag === "enrolled") {
        phase = "done";
        const profRes = await driver.usProfileGet();
        if (profRes.ok) {
          // THE ADOPTION ANNOUNCEMENT (§5): a remotely-caused identity
          // change is always announced, never silent.
          status(
            `this device now follows your profile: ${profRes.value.displayName}, your colour`,
            true,
          );
          onAdopt({ hue: profRes.value.hue, displayName: profRes.value.displayName });
        }
        body.replaceChildren();
        const done = document.createElement("div");
        done.textContent = "joined.";
        body.appendChild(done);
      } else if (st.tag === "expired") {
        phase = "failed";
        status("this code expired — start again", true);
      } else if (st.tag === "failed") {
        phase = "failed";
        status(st.message, true);
      }
      return phase === "done";
    },
  };
  return handle;
}

// --- add flow: trusted device (§5) — the HEAVY ceremony ---------------------

export interface AddPaneHandle {
  tick(): Promise<boolean>;
}

/** The #22 arming delay, ported verbatim (host/demo.ts:~2315's
 * comment): the TIMER is the enforcement, an animation is only its
 * visible form. 700ms matches the credential-drawer constant so the
 * demo has one arming duration, not two the user has to learn. */
const ARM_MS = 700;

/** Mounts the add flow: strip-menu entry ("add a device") → code entry
 * → SAS screen → HEAVY ceremony (statement of consequence + arming
 * delay + never-prefilled device-name field) → devices list. */
export function mountAddPane(
  container: HTMLElement,
  driver: PairingDriver,
  status: (line: string, sticky?: boolean) => void,
): AddPaneHandle {
  ensureStyles();
  container.classList.add("pm-pane");
  container.replaceChildren();

  let phase:
    | "entry"
    | "code-entry"
    | "connecting"
    | "sas"
    | "consequence"
    | "waiting-peer"
    | "done"
    | "failed" = "entry";
  let started = false;
  let armTimer = 0;
  let armed = false;

  const entryBtn = document.createElement("button");
  entryBtn.textContent = "add a device";
  container.appendChild(entryBtn);
  const body = document.createElement("div");
  container.appendChild(body);
  const devicesList = document.createElement("ul");
  devicesList.className = "pm-devices";
  container.appendChild(devicesList);

  const renderDevices = async () => {
    const res = await driver.usDevicesList();
    if (!res.ok) return;
    devicesList.replaceChildren();
    for (const d of res.value) {
      const li = document.createElement("li");
      li.textContent = `${d.name || "(unnamed)"}${d.revoked ? " — revoked" : ""}`;
      devicesList.appendChild(li);
    }
  };

  entryBtn.onclick = () => {
    phase = "code-entry";
    entryBtn.hidden = true;
    body.replaceChildren();
    const label = document.createElement("div");
    label.textContent = "paste or type the code shown on the new device:";
    const input = document.createElement("textarea");
    input.rows = 2;
    input.style.width = "100%";
    input.placeholder = "code (79 characters)";
    const submitBtn = document.createElement("button");
    submitBtn.textContent = "connect";
    submitBtn.onclick = async () => {
      const raw = input.value.trim();
      if (!raw) return;
      submitBtn.disabled = true;
      phase = "connecting";
      const res = await driver.pairAddStart(raw);
      if (!res.ok) {
        status(`could not start pairing: ${res.error}`, true);
        phase = "failed";
        return;
      }
      started = true;
      status("connecting…");
    };
    body.append(label, input, submitBtn);
  };

  const renderSasScreen = (sas: string) => {
    phase = "sas";
    body.replaceChildren();
    const label = document.createElement("div");
    label.textContent = "confirm this code matches the new device:";
    const sasEl = renderSas(sas);
    const nextBtn = document.createElement("button");
    nextBtn.textContent = "codes match — continue";
    nextBtn.onclick = () => renderConsequenceScreen();
    body.append(label, sasEl, nextBtn);
  };

  /** HEAVY ceremony (PAIRING.md §5 + #22): enrollment gives the new
   * device admin over EVERYTHING in the account, so this is THE
   * consequential grant in this flow and pays the full ceremony —
   * statement of consequence, arming delay, and a device-name field
   * the user must type (never prefilled: neither from anything the
   * joiner sent nor from any default visor would otherwise invent —
   * same NO-FABRICATION rule host/demo.ts's identity record follows). */
  const renderConsequenceScreen = () => {
    phase = "consequence";
    body.replaceChildren();
    const warn = document.createElement("div");
    warn.className = "pm-consequence";
    warn.textContent =
      "this device will get full access to everything in your account. " +
      "Only continue if you started this from a device you trust.";
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "your word for this device:";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = ""; // NEVER prefilled — see comment above.
    nameLabel.appendChild(document.createElement("br"));
    nameLabel.appendChild(nameInput);
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "pm-armed";
    confirmBtn.textContent = `arming… (${ARM_MS}ms)`;
    confirmBtn.disabled = true;
    armed = false;
    // THE ARMING DELAY: the enforcement is the timer, not the visible
    // countdown text (which is just a courtesy here; the drawer's own
    // slide animation is the "visible form" in host/demo.ts and drops
    // under prefers-reduced-motion without dropping the timer).
    armTimer = setTimeout(() => {
      armed = true;
      confirmBtn.disabled = false;
      confirmBtn.textContent = "grant full access";
    }, ARM_MS) as unknown as number;
    confirmBtn.onclick = async () => {
      // Defence-in-depth: even if something raced past the `disabled`
      // attribute (synthetic click, a11y tooling), the click handler
      // itself refuses to act before the timer fired.
      if (!armed) return;
      const deviceName = nameInput.value.trim();
      if (!deviceName) {
        status("give the new device a name first", true);
        return;
      }
      confirmBtn.disabled = true;
      const res = await driver.pairAddConfirm(deviceName);
      if (!res.ok) {
        status(`could not confirm: ${res.error}`, true);
        phase = "failed";
        return;
      }
      phase = "waiting-peer";
      status("waiting for the new device to finish joining…");
    };
    body.append(warn, nameLabel, confirmBtn);
  };

  const handle: AddPaneHandle = {
    async tick() {
      if (!started || phase === "done" || phase === "failed") return phase === "done";
      const res = await driver.pairAddStatus();
      if (!res.ok) return false;
      const st = res.value;
      if (st.tag === "sas-ready" && phase === "connecting") {
        renderSasScreen(st.sas);
      } else if (st.tag === "enrolled") {
        phase = "done";
        status("device added", true);
        body.replaceChildren();
        const done = document.createElement("div");
        done.textContent = "done.";
        body.appendChild(done);
        await renderDevices();
      } else if (st.tag === "failed") {
        phase = "failed";
        status(st.message, true);
        clearTimeout(armTimer);
      }
      return phase === "done";
    },
  };
  return handle;
}
