// The demo page: TodoMVC on a selectable backend
// (?backend=direct|queued|channel, default direct — the same-realm
// production configuration per the #15 fast-path plan).

import { isBackendKind, type BackendKind } from "./backend.ts";
import { startTodoApp } from "./app.ts";

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
    const kind: BackendKind = isBackendKind(param) ? param : "direct";
    const guest = params.get("guest") === "dioxus" ? "dioxus" : "hand";
    const artifact = guest === "dioxus" ? "todomvc-dioxus" : "todomvc";

    const route = () => location.hash.replace(/^#\/?/, "");
    container.textContent = "";
    const app = await startTodoApp(kind, container, route, showError, artifact);
    addEventListener("hashchange", () => {
      app.sendRoute(route()).catch(showError);
    });

    const note = document.querySelector("#backend-note");
    if (note) note.textContent = `backend: ${kind} · guest: ${guest}`;
  } catch (e) {
    showError(e);
  }
}
