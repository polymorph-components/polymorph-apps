// Event records: the only thing that flows guest-ward from the DOM.
// One builder used by every backend so record semantics are defined once.

export interface UiEvent {
  token: number;
  kind: string;
  key?: string;
  value?: string;
  checked?: boolean;
}

export function attachListener(
  node: Element,
  kind: string,
  token: number,
  dispatch: (ev: UiEvent) => void,
): void {
  node.addEventListener(kind, (e) => {
    const ev: UiEvent = { token, kind };
    if (kind === "keydown") {
      const key = (e as KeyboardEvent).key;
      ev.key = key;
      if (key === "Enter") e.preventDefault();
    }
    const target = e.currentTarget as HTMLInputElement;
    if (target && typeof target.value === "string") ev.value = target.value;
    if (target && target.type === "checkbox") ev.checked = target.checked;
    dispatch(ev);
  });
}
