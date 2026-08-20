// The spike's framework visor (#22, provisional until user-tested):
// trusted shell UI rendered strictly OUTSIDE the app rectangle. Trust
// anchors are position (this code owns everything around #app) and
// absolute interaction rules (the visor never asks for secret input in a
// drawer) — never visual style. The modal visor pauses the app's event
// queue: the app cannot observe or race the user's interaction.
//
// Interaction-emergence experiment: visor interactions are revealed by
// the strip sliding DOWN, exposing the interaction surface above it. The
// animation is both transition and enforced arming delay (ARM_MS):
// controls stay disabled until it elapses, defeating baited mis-taps
// (an app training rapid taps at a position where a visor control is
// about to appear). Enforcement is the timer, not the animation —
// prefers-reduced-motion changes the visuals, never the delay.

import type { Runner } from "./app.ts";

const ARM_MS = 700; // <= 1s per the experiment's budget

export interface Visor {
  bind(runner: Runner): void;
  killed: boolean;
}

export function initVisor(petname: string, detail: string): Visor {
  const strip = document.getElementById("visor") as HTMLElement;
  const drawer = document.getElementById("visor-drawer") as HTMLElement;
  const drawerInner = drawer.firstElementChild as HTMLElement;
  const dim = document.getElementById("visor-dim") as HTMLElement;
  const appHost = document.getElementById("app") as HTMLElement;
  let runner: Runner | null = null;
  let open = false;

  const visor: Visor = {
    killed: false,
    bind(r: Runner) {
      runner = r;
    },
  };

  // --- the strip (position is the trust anchor: apps cannot paint here) ---
  strip.replaceChildren();
  const title = document.createElement("span");
  title.className = "visor-petname";
  title.textContent = `⛨ ${petname}`;
  const caps = document.createElement("span");
  caps.className = "visor-caps";
  caps.textContent = detail;
  const spacer = document.createElement("span");
  spacer.className = "visor-spacer";
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
    if (open || visor.killed) return;
    open = true;
    runner?.pause();
    const close = () => {
      open = false;
      drawer.classList.remove("visor-open");
      drawerInner.style.height = "0px";
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
    drawer.classList.add("visor-open");
    // Animate to the measured content height: strip and content ride one
    // curve, rigidly glued (the fr-interpolation trick was nonlinear and
    // engine-varied). scrollHeight misses flex-end top-overflow, so
    // measure at height:auto, then animate 0 → target.
    drawerInner.style.height = "auto";
    const target = drawerInner.offsetHeight;
    drawerInner.style.height = "0px";
    void drawerInner.offsetHeight;
    drawerInner.style.height = `${target}px`;
    // The arming delay: the timer is the enforcement; the slide is its
    // visible form. A press started while disabled produces no click.
    setTimeout(() => {
      for (const b of controls) b.disabled = false;
      root.classList.add("visor-armed");
    }, ARM_MS);
  }

  function consentContent(close: () => void) {
    const root = document.createElement("div");
    root.className = "visor-sheet";
    const h = document.createElement("h2");
    h.textContent = "Simulated consent prompt";
    const p = document.createElement("p");
    // Untrusted-string discipline: app-supplied text is quoted and styled
    // as foreign, never part of the visor's own sentence.
    p.append("The app ");
    const q = document.createElement("q");
    q.className = "visor-foreign";
    q.textContent = petname;
    p.append(
      q,
      " requests a demonstration capability. While this surface is open, the app receives no input.",
    );
    const note = document.createElement("p");
    note.className = "visor-note";
    note.textContent =
      "Controls arm only after the reveal completes. The visor never asks you to type a secret here.";
    const row = document.createElement("div");
    row.className = "visor-row";
    const allow = document.createElement("button");
    allow.textContent = "Allow";
    const deny = document.createElement("button");
    deny.textContent = "Deny";
    allow.onclick = close;
    deny.onclick = close;
    row.append(allow, deny);
    root.append(h, p, note, row);
    return { root, controls: [allow, deny] };
  }

  function killContent(close: () => void) {
    const root = document.createElement("div");
    root.className = "visor-sheet";
    const h = document.createElement("h2");
    h.textContent = "Suspend this app?";
    const p = document.createElement("p");
    p.textContent =
      "Input delivery stops and the app's surface is removed. (Spike semantics; real teardown is a deltic embedder-API question — #22.)";
    const row = document.createElement("div");
    row.className = "visor-row";
    const suspend = document.createElement("button");
    suspend.textContent = "Suspend";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    suspend.onclick = () => {
      close();
      visor.killed = true;
      runner?.pause(); // never resumed: delivery stops for good
      const note = document.createElement("div");
      note.className = "visor-killed";
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
  return visor;
}
