import { createSignal, For, onCleanup, onMount } from "solid-js";
import { formatBytes } from "../../src/web/client/shared/format.js";
import { describePlain, limitedItem } from "../../src/web/client/shared/item-row.js";

export type Item = {
  id: string;
  kind: string;
  size: number;
  name?: string;
  filename?: string;
  text?: string;
  preview?: string;
  readsLeft?: number;
  burn?: boolean;
};
export type Snapshot = { namespace: string; items: Item[]; api: string };

/** A single Solid-owned root: legacy page code never mutates its DOM. */
export const Namespace = (props: Snapshot) => {
  const [items, setItems] = createSignal(props.items);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let composer!: HTMLTextAreaElement;
  let stopped = false;
  let pending: AbortController | undefined;
  const refresh = async () => {
    if (pending) return;
    const controller = new AbortController();
    pending = controller;
    try {
      const response = await fetch(`${props.api}/ls?summary`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Refresh failed (${response.status})`);
      const next = (await response.json()) as Item[];
      if (!stopped) {
        setItems(next);
        setError("");
      }
    } catch (reason) {
      if (!stopped) setError(String(reason));
    } finally {
      pending = undefined;
    }
  };
  onMount(() => {
    const timer = setInterval(() => void refresh(), 5000);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
      pending?.abort();
    });
  });
  const send = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch(`${props.api}/new`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: composer.value,
      });
      if (!response.ok) throw new Error(`Send failed (${response.status})`);
      composer.value = "";
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main>
      <h1>{props.namespace}</h1>
      <p>Solid SSR pilot · refreshes every five seconds</p>
      <form method="post" action={`${props.api}/new`} onSubmit={send}>
        <label for="text">Text</label>
        <textarea id="text" name="text" ref={composer} required />
        <button disabled={busy()} type="submit">
          Send
        </button>
      </form>
      <p role="status">{error()}</p>
      <ol>
        <For each={items()}>
          {(item) => (
            <li>
              <span>{limitedItem(item) ? "Hidden until opened" : describePlain(item).title}</span>{" "}
              <small>{formatBytes(item.size)}</small>{" "}
              <a href={`${props.api}/${item.id}/d`}>
                {limitedItem(item) ? "Open (uses a read)" : "Download"}
              </a>
            </li>
          )}
        </For>
      </ol>
    </main>
  );
};
