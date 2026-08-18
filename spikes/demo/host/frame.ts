// The frame side of the sandboxed-surface split (#16): this module runs
// INSIDE the sandboxed iframe, on an opaque origin, with no reference to
// the shell's realm. Its only channel to the shell is the MessagePort it
// is handed at startup; its only job is to run the applier — which
// re-validates every op independently of the shell-side surface
// front-end (see ../../todomvc/host/applier.ts:1).
//
// The wire protocol is exactly backend-channel.ts's
// (../../todomvc/host/backend-channel.ts:13), with the MessageChannel
// crossing a document boundary instead of staying in one realm, plus one
// frame→shell message the same-realm version has no need for: `height`,
// so the shell can size an iframe it cannot measure from the inside.

import { createApplier } from "../../todomvc/host/applier.ts";
import type { Op } from "../../todomvc/host/backend-queued.ts";
import type { UiEvent } from "../../todomvc/host/events.ts";

type ShellMsg =
  | { t: "ops"; ops: Op[] }
  | { t: "drain"; id: number }
  | { t: "theme"; mode: "light" | "dark" };
type FrameMsg =
  | { t: "event"; ev: UiEvent }
  | { t: "drained"; id: number }
  | { t: "height"; px: number };

let wired = false;

function wire(port: MessagePort): void {
  // One port per frame, for the frame's lifetime. A second `port`
  // message is either a bug or an attempt to re-point the surface;
  // either way the first port keeps the frame.
  if (wired) return;
  wired = true;

  const applier = createApplier(
    document.body,
    (ev) => port.postMessage({ t: "event", ev } satisfies FrameMsg),
  );

  // Measure the BODY's flow box, not documentElement.scrollHeight: the
  // frame is rendered with scrolling disabled (the shell sizes it, so an
  // inner scrollbar would be wrong), and under overflow:hidden
  // scrollHeight collapses to the clipped viewport — the frame would
  // truthfully report its own clamp forever. `bottom` includes the
  // top offset reserved for TodoMVC's absolutely-positioned title.
  const postHeight = () => {
    const rect = document.body.getBoundingClientRect();
    port.postMessage({
      t: "height",
      px: Math.ceil(rect.bottom + 8),
    } satisfies FrameMsg);
  };

  port.onmessage = (m: MessageEvent<ShellMsg>) => {
    if (m.data.t === "ops") {
      try {
        applier.apply(m.data.ops);
      } catch (err) {
        // A silent applier failure is indistinguishable from "nothing
        // rendered" when the shell cannot read this document.
        window.parent.postMessage({ t: "fault", msg: `apply: ${err}` }, "*");
      }
      // After every apply: the shell sizes the frame from this, and it
      // is the only measurement it can take of a cross-origin document.
      postHeight();
    } else if (m.data.t === "theme") {
      // Coarse mode ONLY. "light"/"dark" is already inferable by any
      // content via prefers-color-scheme, so telling the component
      // leaks nothing new — whereas chrome's personal anchor colour
      // must never cross this boundary in any form.
      const mode = m.data.mode === "dark" ? "dark" : "light";
      document.documentElement.dataset.theme = mode;
    } else if (m.data.t === "drain") {
      port.postMessage({ t: "drained", id: m.data.id } satisfies FrameMsg);
    }
  };
  port.start();

  // Height is REPORTED, not measured by the shell — and it must be
  // reported continuously. The first report used to race the
  // render-blocking stylesheet: layout was not yet available, the frame
  // truthfully said 0, the shell clamped to its floor, and nothing ever
  // corrected it because a quiet app produces no further applies. An
  // observer covers every later cause too (fonts, images, wrapping).
  const observer = new ResizeObserver(() => postHeight());
  observer.observe(document.documentElement);
  globalThis.addEventListener("load", () => postHeight());
  postHeight();
}

// The shell cannot address this frame by origin (it is opaque), so the
// handshake is: we announce ourselves, the shell replies to our
// contentWindow with the port. The shell matches on `e.source`, which is
// the only unforgeable identifier either side has here.
globalThis.addEventListener("message", (e: MessageEvent) => {
  // Accept the port ONLY from the embedder. Sibling frames can obtain a
  // handle to this one (`parent.frames[i]` is reachable cross-origin) and
  // postMessage to it; without this check the first sibling to send a
  // port would become this frame's shell and drive its DOM. Origin
  // cannot be checked here — every sandboxed frame reports "null" — so
  // the source identity is the check.
  if (e.source !== window.parent) return;
  const data = e.data as { t?: unknown } | null;
  if (!data || typeof data !== "object" || data.t !== "port") return;
  const port = e.ports[0];
  if (!port) return;
  wire(port);
});

// The frame's console is not readable from the shell, and a silent
// applier failure looks exactly like "nothing rendered". Report faults.
globalThis.addEventListener("error", (e) => {
  window.parent.postMessage(
    { t: "fault", msg: `${e.message} @${e.filename}:${e.lineno}` },
    "*",
  );
});

window.parent.postMessage({ t: "frame-ready" }, "*");
