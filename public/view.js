// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { element, readConfig, request, SITE, setupNamespaceField } from "./common.js";
import { describeOpened, describePlain, limitedItem } from "./items.js";
import {
  normalizeSecretName,
  openSealedSpace,
  openSharedItem,
  openViewEntry,
  secretNameProblem,
  textDownloadName,
} from "./k.mjs";
import { failPage, revealPage } from "./loading.js";
import { createItemList } from "./namespaces/item-list.js";
import { createStatus } from "./status.js";

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
    return {
      url: `${window.location.origin}${entry.url}/c`,
      key: await bodyKey(),
      sealedSize: item.size,
      size: info.size,
      mime: info.mime || "application/octet-stream",
      filename:
        info.kind === "text" ? textDownloadName(info.title, item.id) : info.filename || "file",
    };
  },
};

let itemList;
const show = async (current) => {
  if (!current) throw new Error("This shared view is no longer available.");
  if (view && current.viewId !== view.viewId) throw new Error("The shared view changed.");
  view = current;
  // Share responses hide namespace item IDs. Their opaque URL tokens identify
  // rows locally without revealing those IDs to readers of the view.
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
const refreshButton = element("#refresh");
refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  try {
    await refresh();
  } catch (error) {
    status.error(error.message);
  } finally {
    refreshButton.disabled = false;
  }
});
show(view)
  .then(revealPage)
  .catch((error) => failPage(error.message));
setInterval(itemList.updateExpiries, 30_000);

/** Each item is checked again before copying: a live view is not an atomic snapshot. */
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
    const space = encrypted ? await openSealedSpace(name) : null;
    destination = encrypted ? `${SITE}/e/${space.id}` : `${SITE}/${encodeURIComponent(name)}`;
    const headers = space ? { "Write-Key": space.writeKey } : {};
    const existing = await (await request(`${destination}/views`, { headers })).json();
    if (existing.items.length || existing.views.length) {
      throw new Error("Choose a new, empty destination namespace.");
    }
    // Capture membership when cloning starts, not when this page was opened.
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
      const isText = info.kind === "text";
      const cloneTitle = isText && limitedItem(before) ? "" : info.title;
      let saved;
      if (space) {
        const metadata = isText
          ? { kind: "text", title: cloneTitle, size: bytes.byteLength }
          : {
              kind: "file",
              title: info.title,
              filename: info.filename,
              mime: info.mime,
              size: bytes.byteLength,
            };
        const sent = await space.sealItem(bytes, metadata);
        saved = await request(`${destination}/new`, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/octet-stream",
            "X-Sealed-Metadata": sent.header,
          },
          body: sent.body,
        });
      } else if (isText) {
        saved = await request(`${destination}/new`, {
          method: "POST",
          headers: { "Content-Type": "text/plain; charset=utf-8", "No-Dedup": "1" },
          body: bytes,
        });
        const item = await saved.json();
        if (!limitedItem(before) && info.title && info.title !== item.name) {
          await request(`${destination}/${item.id}/n`, {
            method: "POST",
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body: info.title,
          });
        }
      } else {
        saved = await request(`${destination}/new`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Filename": encodeURIComponent(info.filename || "file"),
            "No-Dedup": "1",
          },
          body: bytes,
        });
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
