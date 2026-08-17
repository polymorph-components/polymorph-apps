// The spike's framework chrome (#22, provisional until user-tested):
// trusted shell UI rendered strictly OUTSIDE the app rectangle. Trust
// anchors are position (this code owns everything around #app) and the
// user's personalization secret (shell storage; no app capability can
// read it) — never visual style. Modal chrome pauses the app's event
// queue: the app cannot observe or race the user's interaction with a
// prompt.

import type { Runner } from "./app.ts";

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
  const overlay = document.getElementById("chrome-overlay") as HTMLElement;
  const appHost = document.getElementById("app") as HTMLElement;
  let runner: Runner | null = null;

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

  // --- the consent sheet (modal: pauses the app's event queue) -----------
  const openSheet = () => {
    runner?.pause();
    overlay.replaceChildren();
    overlay.hidden = false;
    const sheet = document.createElement("div");
    sheet.className = "chrome-sheet";
    const secret = document.createElement("div");
    secret.className = "chrome-secret";
    secret.textContent = personalSecret();
    const h = document.createElement("h2");
    h.textContent = "Simulated consent prompt";
    const p = document.createElement("p");
    // Untrusted-string discipline: the app-supplied text is quoted and
    // styled as foreign, never part of chrome's own sentence.
    p.append("The app ");
    const q = document.createElement("q");
    q.className = "chrome-foreign";
    q.textContent = petname;
    p.append(q, " requests a demonstration capability. While this sheet is open, the app receives no input.");
    const note = document.createElement("p");
    note.className = "chrome-note";
    note.textContent =
      "Your personalization mark is shown above. A real prompt always shows it; an app-drawn fake cannot.";
    const row = document.createElement("div");
    row.className = "chrome-row";
    const allow = document.createElement("button");
    allow.textContent = "Allow";
    const deny = document.createElement("button");
    deny.textContent = "Deny";
    const close = () => {
      overlay.hidden = true;
      overlay.replaceChildren();
      runner?.resume();
    };
    allow.onclick = close;
    deny.onclick = close;
    row.append(allow, deny);
    sheet.append(secret, h, p, note, row);
    overlay.append(sheet);
  };

  const kill = () => {
    chrome.killed = true;
    runner?.pause(); // never resumed: delivery stops for good
    const note = document.createElement("div");
    note.className = "chrome-killed";
    note.textContent =
      "App suspended by user. (Spike semantics: input delivery stopped, DOM removed; real teardown is a deltic embedder-API question — #22.)";
    appHost.replaceChildren(note);
  };

  consentBtn.onclick = openSheet;
  killBtn.onclick = kill;
  return chrome;
}
