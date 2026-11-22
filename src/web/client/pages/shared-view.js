// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import {
  normalizeSecretName,
  openSharedItem,
  openViewEntry,
  secretNameProblem,
} from "../../../sdk/k.mjs";
import { createItemList } from "../features/namespace/item-list.js";
import { plainMode, sealedMode } from "../features/namespace/modes.js";
import { element, readConfig, request, setupNamespaceField } from "../lib/common.js";
import { describeOpened, describePlain, limitedItem, sealedStream } from "../lib/items.js";
import { createStatus } from "../lib/status.js";
import { failUnlocking, finishUnlocking } from "../lib/unlocking.js";

const status = createStatus(element("#view-status"));
const cloneConfig = readConfig();
setupNamespaceField(element("#clone-field"), element("#clone-hint"), cloneConfig);
let view = JSON.parse(element("#view-data").textContent);
const viewKey = decodeURIComponent(window.location.hash.slice(1));
let entriesById = new Map();
const openedItems = new Map();

const entryFor = (item) => {
  const entry = entriesById.get(item.id);
  if (!entry) throw new Error("This item is no longer in the shared view.");
  return entry;
};

const describeEntry = async (entry) => {
  if (entry.item.kind !== "sealed")
    return { info: describePlain(entry.item), itemKey: "", open: null, bodyKey: null };
  if (!viewKey) throw new Error("Incomplete link: its view key is missing after #.");
  const signature = JSON.stringify([
    view.viewId,
    entry.envelope,
    entry.item.metadata,
    entry.item.size,
  ]);
  const cached = openedItems.get(entry.url);
  if (cached?.signature === signature) return cached.value;
  const itemKey = await openViewEntry(view.viewId, viewKey, entry.envelope);
  const opened = await openSharedItem(itemKey, entry.item.metadata, entry.item.size);
  const value = {
    info: describeOpened(opened.metadata),
    itemKey,
    open: opened.open,
    bodyKey: opened.bodyKey,
  };
  openedItems.set(entry.url, { signature, value });
  return value;
};

const contentBytes = async (item) => {
  const entry = entryFor(item);
  const response = await request(`${entry.url}/c`, { cache: "no-store" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const { open } = await describeEntry(entry);
  return open ? open(bytes) : bytes;
};

const mode = {
  basePath: "",
  describe: async (item) => {
    const entry = entryFor(item);
    const { info, itemKey } = await describeEntry(entry);
    return { ...info, itemUrl: `${entry.url}${itemKey ? `#${itemKey}` : ""}` };
  },
  loadText: async (item) =>
    item.kind === "text" && item.text !== undefined
      ? item.text
      : new TextDecoder().decode(await contentBytes(item)),
  loadBlob: async (item) => {
    const entry = entryFor(item);
    const { info } = await describeEntry(entry);
    return new Blob([await contentBytes(item)], { type: info.mime || "application/octet-stream" });
  },
  mediaUrl: (item) => `${entryFor(item).url}/c`,
  downloadUrl: (item) => (item.kind === "sealed" ? null : `${entryFor(item).url}/d`),
  streamOf: async (item) => {
    const entry = entryFor(item);
    const { info, bodyKey } = await describeEntry(entry);
    return sealedStream({
      url: `${window.location.origin}${entry.url}/c`,
      key: await bodyKey(),
      item,
      details: info,
    });
  },
};

let itemList;
const show = async (current) => {
  if (!current) throw new Error("This shared view is no longer available.");
  if (view && current.viewId !== view.viewId) throw new Error("The shared view changed.");
  view = current;
  // Opaque URL tokens name rows locally without revealing the namespace's item IDs.
  const entries = current.entries.map((entry) => ({
    ...entry,
    item: { ...entry.item, id: entry.url.split("/").pop() },
  }));
  entriesById = new Map(entries.map((entry) => [entry.item.id, entry]));
  await itemList.renderItems(entries.map((entry) => entry.item));
  status.clear();
};
const refresh = async () => {
  const current = await (
    await request(`${window.location.pathname}.json`, { cache: "no-store" })
  ).json();
  await show(current);
};
itemList = createItemList({
  status,
  access: { canWrite: () => false, writeHeaders: () => ({}) },
  refreshUnlessLive: refresh,
  loadItems: refresh,
});
itemList.setMode(mode);
show(view)
  .then(finishUnlocking)
  .catch((error) => {
    if (document.querySelector("#page-loading")) failUnlocking(error.message);
    else status.error(error.message);
  });
setInterval(itemList.updateExpiries, 30_000);

/** A live view is not an atomic snapshot. */
const clone = async (event) => {
  event.preventDefault();
  const form = element("#clone-form");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  let copied = 0;
  let skipped = 0;
  let destination = "";
  try {
    const encrypted = element("#clone-encrypted").checked;
    const typedName = element("#clone-name").value;
    const name = encrypted ? normalizeSecretName(typedName) : typedName.trim().toLowerCase();
    if (encrypted) {
      const problem = secretNameProblem(name, cloneConfig.sealed.maxNameLength);
      if (problem) throw new Error(problem);
    }
    // Sent as the namespace page sends: the destination's own mode.
    let target = null;
    const writeHeaders = () => (target?.writeKey ? { "Write-Key": target.writeKey } : {});
    target = encrypted
      ? await sealedMode({ secretName: name }, writeHeaders)
      : plainMode(name, writeHeaders);
    destination = target.basePath;
    const existing = await (
      await request(`${destination}/views`, { headers: writeHeaders() })
    ).json();
    if (existing.items.length || existing.views.length) {
      throw new Error("Choose a new, empty destination namespace.");
    }
    // When cloning starts, not when this page was opened.
    const current = await (
      await request(`${window.location.pathname}.json`, { cache: "no-store" })
    ).json();
    if (current.viewId !== view.viewId) throw new Error("The shared view changed.");
    const includeLimited = element("#clone-limited").checked;
    for (const entry of [...current.entries].reverse()) {
      if (limitedItem(entry.item) && !includeLimited) {
        skipped += 1;
        continue;
      }
      status.progress(`Cloning… ${copied} copied, ${skipped} skipped.`);
      const before = await (await request(`${entry.url}.json`, { cache: "no-store" })).json();
      const { info, open } = await describeEntry({ ...entry, item: before });
      const response = await request(`${entry.url}/c`, { cache: "no-store" });
      const sealed = new Uint8Array(await response.arrayBuffer());
      const bytes = open ? await open(sealed) : sealed;
      if (!limitedItem(before)) {
        const after = await (await request(`${entry.url}.json`, { cache: "no-store" })).json();
        if ((after.updatedAt ?? after.createdAt) !== (before.updatedAt ?? before.createdAt)) {
          skipped += 1;
          continue;
        }
      }
      // A copy is new: no limits, no expiry chosen, and kept even if the same contents are there.
      const settings = { deduplicate: false };
      if (info.kind === "text") {
        // Only a name given by hand: a text named by its start is named so again.
        const named = limitedItem(before)
          ? undefined
          : before.kind === "sealed"
            ? info.title
            : before.name;
        await target.sendText(new TextDecoder().decode(bytes), { ...settings, name: named });
      } else {
        const file = new File([bytes], info.filename || "file", {
          type: info.mime || "application/octet-stream",
        });
        await target.sendFile(file, settings);
      }
      copied += 1;
    }
    status.success(
      `Clone complete: ${copied} copied, ${skipped} skipped. Open ${encrypted ? `/e#${name}` : destination}.`,
    );
  } catch (error) {
    status.error(
      `Clone incomplete: ${copied} copied, ${skipped} skipped${destination ? ` in ${destination}` : ""}. ${error.message}`,
    );
  } finally {
    button.disabled = false;
  }
};

element("#clone-form").addEventListener("submit", clone);
