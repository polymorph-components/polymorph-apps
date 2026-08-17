// The spike's framework chrome (#22, provisional until user-tested):
// trusted shell UI rendered strictly OUTSIDE the app rectangle. Trust
// anchors are position (this code owns everything around #app) and the
// user's personalization secret (shell storage; no app capability can
// read it) — never visual style. Modal chrome pauses the app's event
// queue: the app cannot observe or race the user's interaction.
//
// Interaction-emergence experiment: chrome interactions are revealed by
// the strip sliding DOWN, exposing the interaction surface above it. The
// animation is both transition and enforced arming delay (ARM_MS):
// controls stay disabled until it elapses, defeating baited mis-taps
// (an app training rapid taps at a position where a chrome control is
// about to appear). Enforcement is the timer, not the animation —
// prefers-reduced-motion changes the visuals, never the delay.

import type { Runner } from "./app.ts";

const ARM_MS = 700; // <= 1s per the experiment's budget

const SECRET_KEY = "polymorph-spike-chrome-secret";
const EMOJI = ["🦆", "🌵", "🚲", "🪐", "🍉", "🦞", "🎈", "🗿", "🌊", "🔭"];
const WORDS = [
  "amber",
  "briar",
  "cobalt",
  "dune",
  "ember",
  "fjord",
  "grove",
  "harbor",
  "iris",
  "juniper",
];

function personalSecret(): string {
  let s = localStorage.getItem(SECRET_KEY);
  if (!s) {
    const pick = (xs: string[]) => xs[Math.floor(Math.random() * xs.length)];
    s = `${pick(EMOJI)} ${pick(WORDS)}-${pick(WORDS)}`;
    localStorage.setItem(SECRET_KEY, s);
  }
  return s;
}

export interface Chrome {
  bind(runner: Runner): void;
  killed: boolean;
}

export function initChrome(petname: string, detail: string): Chrome {
  const strip = document.getElementById("chrome") as HTMLElement;
  const drawer = document.getElementById("chrome-drawer") as HTMLElement;
  const drawerInner = drawer.firstElementChild as HTMLElement;
  const dim = document.getElementById("chrome-dim") as HTMLElement;
  const appHost = document.getElementById("app") as HTMLElement;
  let runner: Runner | null = null;
  let open = false;

  const chrome: Chrome = {
    killed: false,
    bind(r: Runner) {
      runner = r;
    },
  };

  // --- the strip (position is the trust anchor: apps cannot paint here) ---
  strip.replaceChildren();
  const title = document.createElement("span");
  title.className = "chrome-petname";
  title.textContent = `⛨ ${petname}`;
  const caps = document.createElement("span");
  caps.className = "chrome-caps";
  caps.textContent = detail;
  const spacer = document.createElement("span");
  spacer.className = "chrome-spacer";
  const consentBtn = document.createElement("button");
  consentBtn.textContent = "consent demo";
  const killBtn = document.createElement("button");
  killBtn.textContent = "kill";
  strip.append(title, caps, spacer, consentBtn, killBtn);

  // --- the drawer: interactions emerge from above the strip ---------------
  // openDrawer pauses the app, slides the strip down, and arms the
  // interaction's controls only after ARM_MS.
  function openDrawer(
    build: (close: () => void) => { root: HTMLElement; controls: HTMLButtonElement[] },
  ) {
    if (open || chrome.killed) return;
    open = true;
    runner?.pause();
    const close = () => {
      open = false;
      drawer.classList.remove("chrome-open");
      dim.hidden = true;
      runner?.resume();
      // Clear content after the collapse transition would have finished.
      setTimeout(() => {
        if (!open) drawerInner.replaceChildren();
      }, ARM_MS);
    };
    const { root, controls } = build(close);
    drawerInner.replaceChildren(root);
    for (const b of controls) b.disabled = true;
    dim.hidden = false;
    drawer.classList.add("chrome-open");
    // The arming delay: the timer is the enforcement; the slide is its
    // visible form. A press started while disabled produces no click.
    setTimeout(() => {
      for (const b of controls) b.disabled = false;
      root.classList.add("chrome-armed");
    }, ARM_MS);
  }

  function consentContent(close: () => void) {
    const root = document.createElement("div");
    root.className = "chrome-sheet";
    const secret = document.createElement("div");
    secret.className = "chrome-secret";
    secret.textContent = personalSecret();
    const h = document.createElement("h2");
    h.textContent = "Simulated consent prompt";
    const p = document.createElement("p");
    // Untrusted-string discipline: app-supplied text is quoted and styled
    // as foreign, never part of chrome's own sentence.
    p.append("The app ");
    const q = document.createElement("q");
    q.className = "chrome-foreign";
    q.textContent = petname;
    p.append(
      q,
      " requests a demonstration capability. While this surface is open, the app receives no input.",
    );
    const note = document.createElement("p");
    note.className = "chrome-note";
    note.textContent =
      "Your personalization mark is shown above; controls arm only after the reveal completes.";
    const row = document.createElement("div");
    row.className = "chrome-row";
    const allow = document.createElement("button");
    allow.textContent = "Allow";
    const deny = document.createElement("button");
    deny.textContent = "Deny";
    allow.onclick = close;
    deny.onclick = close;
    row.append(allow, deny);
    root.append(secret, h, p, note, row);
    return { root, controls: [allow, deny] };
  }

  function killContent(close: () => void) {
    const root = document.createElement("div");
    root.className = "chrome-sheet";
    const h = document.createElement("h2");
    h.textContent = "Suspend this app?";
    const p = document.createElement("p");
    p.textContent =
      "Input delivery stops and the app's surface is removed. (Spike semantics; real teardown is a deltic embedder-API question — #22.)";
    const row = document.createElement("div");
    row.className = "chrome-row";
    const suspend = document.createElement("button");
    suspend.textContent = "Suspend";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    suspend.onclick = () => {
      close();
      chrome.killed = true;
      runner?.pause(); // never resumed: delivery stops for good
      const note = document.createElement("div");
      note.className = "chrome-killed";
      note.textContent = "App suspended by user.";
      appHost.replaceChildren(note);
    };
    cancel.onclick = close;
    row.append(suspend, cancel);
    root.append(h, p, row);
    return { root, controls: [suspend, cancel] };
  }

  consentBtn.onclick = () => openDrawer(consentContent);
  killBtn.onclick = () => openDrawer(killContent);
  return chrome;
}
