// The frame backend: the queued op protocol carried to a REAL sandboxed
// iframe (#16's per-surface frame; #5's zero-network frame). This is
// backend-channel.ts (../../todomvc/host/backend-channel.ts:1) with the
// applier moved out of the visor's realm entirely — the frame side lives in
// ./frame.ts and reaches the DOM of its own document, never ours.
//
// Why the demo uses this instead of the `direct` backend: the visor's strip
// carries the user's personal colour, which must never be disclosed to
// component code (see web/index.html's visor-strip comment). While the
// guest's nodes lived in THE VISOR'S OWN DOCUMENT, non-disclosure rested on
// an allowlist holding the line against CSS custom-property inheritance,
// class borrowing, getComputedStyle, and whatever the allowlist might
// grow next. A separate document on an OPAQUE ORIGIN closes that whole
// class structurally: there is nothing to read, not merely nothing
// allowed to be read.

import type { Backend } from "../../todomvc/host/backend.ts";
import { createQueuedBackend, type Op } from "../../todomvc/host/backend-queued.ts";
import type { UiEvent } from "../../todomvc/host/events.ts";

type ShellMsg =
  | { t: "ops"; ops: Op[] }
  | { t: "drain"; id: number }
  | { t: "theme"; mode: "light" | "dark" };
type FrameMsg =
  | { t: "event"; ev: UiEvent }
  | { t: "drained"; id: number }
  | { t: "height"; px: number };

/** Floor for the frame's height: an unsized iframe is 150px by spec, and
 * a frame that reports 0 before its first paint would otherwise collapse
 * to invisible. */
const MIN_HEIGHT_PX = 48;

export interface FrameBackend {
  /** Resolves once the port is live — i.e. once ops posted through the
   * returned Backend are guaranteed to reach the frame's applier. */
  backend: Promise<Backend>;
  frame: HTMLIFrameElement;
  destroy(): void;
}

export function createFrameBackend(
  container: HTMLElement,
  dispatch: (ev: UiEvent) => void,
  theme: "light" | "dark" = "light",
): FrameBackend {
  const frame = document.createElement("iframe");
  // THE load-bearing attribute. `allow-scripts` and NOTHING else: with
  // no `allow-same-origin`, the frame's document gets an opaque origin,
  // so it cannot touch the visor's DOM, styles, cookies or storage even
  // though it was served from the visor's own URL space. Adding
  // `allow-same-origin` here would silently undo the entire point of
  // this file.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = "./frame.html";
  frame.style.cssText =
    `width: 100%; border: none; display: block; height: ${MIN_HEIGHT_PX}px;`;
  frame.setAttribute("scrolling", "no");
  container.appendChild(frame);

  let port: MessagePort | null = null;
  let destroyed = false;
  const pendingDrains = new Map<number, () => void>();
  let drainId = 0;

  let resolveBackend!: (b: Backend) => void;
  let rejectBackend!: (e: unknown) => void;
  const backend = new Promise<Backend>((res, rej) => {
    resolveBackend = res;
    rejectBackend = rej;
  });
  // Nobody is required to await a backend whose surface got torn down
  // first; keep the rejection from surfacing as an unhandled rejection
  // when they don't.
  backend.catch(() => {});

  // Faults arrive on the WINDOW channel, which outlives the handshake —
  // the handshake listener below removes itself, and a diagnostic that
  // dies with it reports "no faults" for a frame that is on fire.
  const onFault = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    if ((e.data as { t?: string })?.t !== "fault") return;
    const faults = ((globalThis as Record<string, unknown>).__frameFaults ??= []) as string[];
    faults.push(String((e.data as { msg?: string }).msg));
  };
  globalThis.addEventListener("message", onFault);

  const onWindowMessage = (e: MessageEvent) => {
    // `e.source` is the only identification available: an opaque-origin
    // frame has origin "null", which is shared by every sandboxed frame
    // on the page, so origin checks cannot distinguish OUR frame. Ignore
    // everything that did not come from this frame's window.
    if (destroyed || e.source !== frame.contentWindow) return;
    const data = e.data as { t?: unknown } | null;
    if (!data || typeof data !== "object" || data.t !== "frame-ready") return;
    globalThis.removeEventListener("message", onWindowMessage);
    handshake();
  };
  globalThis.addEventListener("message", onWindowMessage);

  function handshake(): void {
    const channel = new MessageChannel();
    port = channel.port1;

    port.onmessage = (m: MessageEvent<FrameMsg>) => {
      if (destroyed) return;
      if (m.data.t === "event") {
        dispatch(m.data.ev);
      } else if (m.data.t === "drained") {
        pendingDrains.get(m.data.id)?.();
        pendingDrains.delete(m.data.id);
      } else if (m.data.t === "height") {
        // The shell cannot measure a cross-origin document, so the frame
        // reports its own layout height and the shell decides what to do
        // with it. Clamped, and never used for anything but sizing.
        const px = Math.max(MIN_HEIGHT_PX, Math.ceil(Number(m.data.px) || 0));
        frame.style.height = `${px}px`;
      }
    };
    port.start();

    // Target origin "*": an opaque-origin frame CANNOT be addressed by
    // origin (there is no origin string that matches "null" as a
    // targetOrigin), so "*" is the only option. It is safe here because
    // the payload is a bare MessagePort with no secret in it, and it is
    // delivered to one specific contentWindow rather than broadcast.
    frame.contentWindow!.postMessage({ t: "port" }, "*", [channel.port2]);
    // Coarse mode only — never the anchor colour (see frame.ts).
    channel.port1.postMessage({ t: "theme", mode: theme } satisfies ShellMsg);

    const queued = createQueuedBackend(
      (ops) => port?.postMessage({ t: "ops", ops } satisfies ShellMsg),
    );
    resolveBackend({
      ...queued,
      // The drain round-trip, exactly as backend-channel.ts does it: a
      // marker chases the last op batch through the same ordered port,
      // so resolution means "applied", not merely "posted".
      drain: () =>
        new Promise<void>((resolve) => {
          if (destroyed || !port) return resolve();
          const id = drainId++;
          pendingDrains.set(id, resolve);
          port.postMessage({ t: "drain", id } satisfies ShellMsg);
        }),
    });
  }

  return {
    backend,
    frame,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      globalThis.removeEventListener("message", onWindowMessage);
      globalThis.removeEventListener("message", onFault);
      // Resolve every waiter rather than leaving them hanging: a drain
      // on a dead surface is vacuously complete.
      for (const done of pendingDrains.values()) done();
      pendingDrains.clear();
      if (port) {
        port.onmessage = null;
        port.close();
        port = null;
      } else {
        rejectBackend(new Error("frame backend destroyed before it was ready"));
      }
      frame.remove();
    },
  };
}
