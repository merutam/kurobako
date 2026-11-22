import { hydrate } from "solid-js/web";
import { Namespace, type Snapshot } from "./Namespace";

const root = document.getElementById("root");
const data = document.getElementById("snapshot")?.textContent;
if (!root || !data) throw new Error("Missing SSR snapshot or hydration root.");
const snapshot = JSON.parse(data) as Snapshot;
const dispose = hydrate(() => <Namespace {...snapshot} />, root);
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) dispose();
});
