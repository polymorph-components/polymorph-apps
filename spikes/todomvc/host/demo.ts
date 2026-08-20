// The demo page: TodoMVC on a selectable backend
// (?backend=direct|queued|channel|frame, default frame — the real
// sandboxed-surface split (#16); harness.ts/bench.ts stay on the three
// same-realm kinds for their own reasons, see those files).

import { isBackendKind, type BackendKind } from "../../../visor/surface/backend.ts";
import { startTodoApp } from "./app.ts";
import { initTodoVisor } from "./visor.ts";

export async function runDemo(): Promise<void> {
  const container = document.getElementById("app") as HTMLElement;

  const showError = (e: unknown) => {
    console.error(e);
    const pre = document.createElement("pre");
    pre.style.cssText =
      "color:#b83f45;white-space:pre-wrap;padding:16px;font-size:12px";
    pre.textContent = `spike failed:\n${
      e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)
    }`;
    container.replaceChildren(pre);
  };

  try {
    const params = new URLSearchParams(location.search);
    const param = params.get("backend");
    const kind: BackendKind = isBackendKind(param) ? param : "frame";
    const guestParam = params.get("guest");
    const guest = guestParam === "dioxus" || guestParam === "preact"
      ? guestParam
      : "hand";
    const artifact = guest === "hand" ? "todomvc" : `todomvc-${guest}`;

    const route = () => location.hash.replace(/^#\/?/, "");
    const visor = initTodoVisor(artifact);
    container.textContent = "";
    const app = await startTodoApp(kind, container, route, showError, artifact);
    visor.bind({ runner: app.runner, teardown: app.teardown });
    addEventListener("hashchange", () => {
      if (visor.killed) return;
      app.sendRoute(route()).catch(showError);
    });

    const note = document.querySelector("#backend-note");
    if (note) note.textContent = `backend: ${kind} · guest: ${guest}`;
  } catch (e) {
    showError(e);
  }
}

