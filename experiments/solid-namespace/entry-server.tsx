import { generateHydrationScript, renderToString } from "solid-js/web";
import { Namespace, type Snapshot } from "./Namespace";

export const render = (snapshot: Snapshot, nonce: string) => {
  snapshot = {
    ...snapshot,
    items: snapshot.items.map((item) => {
      if (!item.burn && item.readsLeft === undefined) return item;
      const { text: _text, preview: _preview, name: _name, ...publicItem } = item;
      return publicItem;
    }),
  };
  const body = renderToString(() => <Namespace {...snapshot} />);
  const data = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  const bootstrap = generateHydrationScript().replace("<script>", `<script nonce="${nonce}">`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Namespace pilot</title>${bootstrap}</head><body><div id="root">${body}</div><script nonce="${nonce}" type="application/json" id="snapshot">${data}</script><script type="module" src="/pilot-assets/client.js"></script></body></html>`;
};
