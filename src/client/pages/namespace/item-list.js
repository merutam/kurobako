// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { defaultTextName, textDownloadName } from "../../../../public/k.mjs";
import { objectAddress, SVG_TYPE, svgAddress } from "../../lib/addresses.js";
import { bundleView } from "../../lib/bundle-view.js";
import {
  choiceGroup,
  compactText,
  copyText,
  element,
  formatAge,
  formatExpiry,
  HIDDEN_TITLE,
  request,
  storage,
} from "../../lib/common.js";
import { confirmAction } from "../../lib/dialog.js";
import {
  audioPlayer,
  canCopyImages,
  copyImage,
  downloadBlob,
  highlightedText,
  limitedItem,
  streamAddress,
  videoPlayer,
} from "../../lib/items.js";
import { createMediaFeed } from "../../lib/media-feed.js";
import { h } from "../../shared/dom.js";
import { itemRow, localizeDates, rowHash, rowState } from "../../shared/item-row.js";

export const createItemList = ({ status, access, refreshUnlessLive, onEdit }) => {
  const itemsList = element("#items");
  const emptyMessage = element("#empty");
  const itemCount = element("#item-count");
  const openMediaLink = element("#open-media");
  const expandModeChoices = element("#expand-mode");
  const { canWrite, writeHeaders } = access;
  let config = null;
  const expandedItems = new Set();
  const closedItems = new Set();
  /** Remembered on this device. */
  const EXPAND_MODES = ["one", "several", "all"];
  const EXPAND_MODE_KEY = "kurobako-expand";
  let expandMode = EXPAND_MODES.includes(storage.get(EXPAND_MODE_KEY))
    ? storage.get(EXPAND_MODE_KEY)
    : "one";
  const isExpanded = (id) => (expandMode === "all" ? !closedItems.has(id) : expandedItems.has(id));
  const itemOpeners = new Map();
  let renderedSignature = "";
  let renderToken = 0;
  /** Unchanged rows are kept as they are, open or closed, previews loaded. */
  let rows = new Map();
  /** Freed when the row goes. */
  const objectUrls = new Map();
  const freeObjectUrls = (id) => {
    for (const url of objectUrls.get(id) ?? []) URL.revokeObjectURL(url);
    objectUrls.delete(id);
  };

  // Only once it changes: the list itself comes from the server.
  const updateExpiries = () => {
    const update = (label, text) => {
      if (label.textContent !== text) label.textContent = text;
    };
    for (const label of itemsList.querySelectorAll("[data-expires-at]")) {
      update(label, formatExpiry(label.dataset.expiresAt));
    }
    for (const label of itemsList.querySelectorAll("[data-created-at]")) {
      update(label, formatAge(label.dataset.createdAt));
    }
  };

  const objectUrl = (blob, id) => {
    const url = objectAddress(blob);
    objectUrls.set(id, [...(objectUrls.get(id) ?? []), url]);
    return url;
  };

  let mode = null;

  /* `opened` keeps a burn-after-reading item read here, after the server deletes it. */
  const opened = new Map();
  let serverItems = [];
  let itemsShown = false;

  const textOf = (entry) => (entry.opened ? entry.opened.text : mode.loadText(entry.item));
  const blobOf = (entry) => (entry.opened ? entry.opened.blob : mode.loadBlob(entry.item));

  const copyItem = async (entry) => {
    try {
      if (entry.info.kind === "text") {
        await copyText(await textOf(entry));
      } else {
        await copyImage(await blobOf(entry));
      }
      status.success("Copied.");
    } catch (error) {
      status.error(error.message);
    }
  };

  /** Burn-after-reading items must be read whole, once. */
  const partsAddress = async (entry) =>
    mode.streamOf && !entry.opened && !limitedItem(entry.item)
      ? streamAddress(await mode.streamOf(entry.item))
      : null;

  /** Decrypted video, audio and SVG go through the Service Worker, which serves them sandboxed. */
  const mediaAddress = async (entry, { preview = false } = {}) => {
    const { item, info } = entry;
    if (!entry.opened && item.kind !== "sealed" && !limitedItem(item)) {
      return {
        src: mode.mediaUrl?.(item) ?? `${mode.basePath}/${encodeURIComponent(item.id)}`,
        revoke: null,
      };
    }
    const isSvg = info.mime === SVG_TYPE;
    const streamed = info.isVideo || info.isAudio || isSvg ? await partsAddress(entry) : null;
    if (streamed) return { src: streamed, revoke: null };
    const blob = await blobOf(entry);
    if (isSvg) return { src: svgAddress(new Uint8Array(await blob.arrayBuffer())), revoke: null };
    if (preview) return { src: objectUrl(blob, item.id), revoke: null };
    const src = objectAddress(blob);
    return { src, revoke: () => URL.revokeObjectURL(src) };
  };

  const mediaFeed = createMediaFeed(mediaAddress);
  openMediaLink.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    mediaFeed.open();
  });

  const downloadItem = async (entry) => {
    try {
      // Never whole in this page's memory.
      const address = await partsAddress(entry);
      if (address) {
        window.location.assign(`${address}?download`);
        return;
      }
      if (entry.info.kind === "text") {
        const name = textDownloadName(entry.opened ? "" : entry.info.title, entry.item.id);
        downloadBlob(new Blob([await textOf(entry)], { type: "text/plain;charset=utf-8" }), name);
      } else {
        downloadBlob(await blobOf(entry), entry.info.filename);
      }
    } catch (error) {
      status.error(error.message);
    }
  };

  const deleteItem = async (entry) => {
    const { item, info } = entry;
    const deleting = await confirmAction({
      title: "Delete this item?",
      subject: info.title,
      message: "It is deleted for everyone, and its share link stops working.",
      confirm: "Delete",
      destructive: true,
    });
    if (!deleting) return;
    try {
      await request(`${mode.basePath}/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: writeHeaders(),
      });
      expandedItems.delete(item.id);
      status.success("Deleted.");
      await refreshUnlessLive();
    } catch (error) {
      status.error(error.message);
    }
  };

  /** Encrypted items add their own key after the #, which opens this item only. */
  const shareItem = async (item) => {
    try {
      const response = await request(`${mode.basePath}/${encodeURIComponent(item.id)}/s`, {
        method: "POST",
        headers: writeHeaders(),
      });
      // The server may not know the address this page was opened at.
      const { pathname } = new URL((await response.text()).trim());
      const key = await mode.shareKey(item);
      const link = `${window.location.origin}${pathname}${key ? `#${key}` : ""}`;
      try {
        await copyText(link);
        status.success(`Share link copied: ${link}`);
      } catch {
        status.success(`Share link: ${link}`);
      }
    } catch (error) {
      status.error(error.message);
    }
  };

  const openOnce = async (entry) => {
    const { item, info } = entry;
    try {
      const content =
        info.kind === "text"
          ? { text: await mode.loadText(item) }
          : { blob: await mode.loadBlob(item) };
      const title = content.text === undefined ? info.title : compactText(content.text);
      opened.set(item.id, { item, info: { ...info, title }, ...content });
      expandedItems.add(item.id);
      status.success(
        item.burn || item.readsLeft === 1
          ? "Opened and deleted from the server."
          : "Opened; one read used.",
      );
      await renderItems(serverItems, { force: true });
    } catch (error) {
      status.error(
        error.message === "Item not found." ? "Someone else already opened it." : error.message,
      );
      await refreshUnlessLive();
    }
  };

  const dismiss = (id) => {
    opened.delete(id);
    expandedItems.delete(id);
    void renderItems(serverItems, { force: true });
  };

  /** Live updates wait until it is done. */
  let renaming = false;

  const renameItem = (entry, title) => {
    const holder = title.closest(".item-toggle") ?? title.parentElement;
    const input = h("input", { type: "text", class: "rename-input", "aria-label": "New name" });
    // Keeping the default name changes nothing.
    const named = entry.info.kind !== "text" || Boolean(entry.item.name);
    const current = entry.info.title === HIDDEN_TITLE ? "" : entry.info.title;
    const initial = named ? current : defaultTextName(current);
    input.value = initial;
    renaming = true;
    holder.hidden = true;
    holder.before(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      input.remove();
      holder.hidden = false;
      renaming = false;
      if (!save || name === initial) {
        await renderItems(serverItems);
        return;
      }
      try {
        await mode.rename(entry.item, name);
        status.success("Renamed.");
      } catch (error) {
        status.error(error.message);
      }
      await refreshUnlessLive();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => void finish(true));
  };

  const rowOf = (entry, position) => ({
    item: entry.item,
    info: entry.info,
    position,
    opened: Boolean(entry.opened),
    canWrite: canWrite(),
    canCopyImages: canCopyImages(),
    downloadUrl: mode.downloadUrl?.(entry.item) ?? null,
  });

  /** Rows made by the server get the same behavior as the browser's. */
  const wireItem = (listItem, entry) => {
    const { item, info } = entry;
    const on = (action, handler) =>
      listItem.querySelector(`[data-action="${action}"]`)?.addEventListener("click", handler);
    const toggle = listItem.querySelector("button.item-toggle");
    const preview = listItem.querySelector(".item-preview");

    // Opening a burn-after-reading item reads it: only its own button does that.
    if (toggle) {
      const body = listItem.querySelector(".item-body");
      const title = listItem.querySelector(".item-title");
      const previewable =
        info.kind === "text" || info.isImage || info.isVideo || info.isAudio || info.isBundle;

      let loaded = false;
      const load = async () => {
        if (loaded || !previewable) return;
        loaded = true;
        try {
          if (info.kind === "text") {
            preview.replaceChildren(highlightedText(await textOf(entry), info.title));
          } else if (info.isBundle) {
            const bytes = new Uint8Array(await (await blobOf(entry)).arrayBuffer());
            preview.replaceChildren(
              bundleView(bytes, { objectUrl: (blob) => objectUrl(blob, item.id) }),
            );
          } else {
            // Plain media streams from the server; encrypted video through the Service Worker.
            const { src } = await mediaAddress(entry, { preview: true });
            if (info.isVideo) {
              preview.replaceChildren(videoPlayer(src));
            } else if (info.isAudio) {
              preview.replaceChildren(audioPlayer(src));
            } else {
              const image = h("img", { alt: info.title, src: src, draggable: "false" });
              const open = h(
                "button",
                {
                  type: "button",
                  class: "media-preview",
                  "aria-label": `Open ${info.title} in media feed`,
                  title: "Open media feed",
                },
                image,
              );
              open.addEventListener("click", () => mediaFeed.open(entry));
              preview.replaceChildren(open);
            }
          }
        } catch (error) {
          loaded = false;
          status.error(error.message);
        }
      };

      const setOpen = (open) => {
        body.hidden = !open;
        if (!open) preview.querySelector("video")?.pause();
        toggle.setAttribute("aria-expanded", String(open));
        listItem.classList.toggle("open", open);
        if (open) void load();
      };
      itemOpeners.set(item.id, setOpen);
      const toggleOpen = () => {
        const open = !isExpanded(item.id);
        if (expandMode === "all") {
          if (open) closedItems.delete(item.id);
          else closedItems.add(item.id);
        } else if (open) {
          if (expandMode === "one") {
            for (const id of expandedItems) itemOpeners.get(id)?.(false);
            expandedItems.clear();
          }
          expandedItems.add(item.id);
        } else {
          expandedItems.delete(item.id);
        }
        setOpen(open);
      };
      // The second click of a double-click (a rename) leaves the row as it was.
      toggle.addEventListener("click", (event) => {
        if (event.detail <= 1) toggleOpen();
      });
      if (title.title) {
        title.addEventListener("dblclick", (event) => {
          event.preventDefault();
          toggleOpen();
          renameItem(entry, title);
        });
      }
      setOpen(isExpanded(item.id));
    }

    on("open-once", () => openOnce(entry));
    on("media", () => mediaFeed.open(entry));
    on("edit", () => onEdit(entry));
    on("copy", () => copyItem(entry));
    on("download", () => downloadItem(entry));
    on("share", () => shareItem(item));
    on("dismiss", () => dismiss(item.id));
    on("delete", () => deleteItem(entry));
  };

  const renderItem = (entry, position) => {
    const listItem = itemRow(h, rowOf(entry, position));
    wireItem(listItem, entry);
    return listItem;
  };

  /** The first render keeps the server's rows still made from the same item. */
  let serverRows = new Map(
    [...itemsList.querySelectorAll("li[data-made]")].map((node) => [node.dataset.id, node]),
  );
  const adoptRow = (node, entry, position) => {
    const place = node.querySelector(".item-position");
    const shown = position ? String(position) : "";
    if (place.textContent !== shown) place.textContent = shown;
    // Only this browser knows these.
    if (entry.info.isImage && !canCopyImages())
      node.querySelector('[data-action="copy"]')?.remove();
    localizeDates(node);
    wireItem(node, entry);
    return node;
  };

  choiceGroup(expandModeChoices, expandMode, (picked) => {
    expandMode = picked;
    storage.set(EXPAND_MODE_KEY, expandMode);
    closedItems.clear();
    if (expandMode === "one" && expandedItems.size > 1) {
      const keep = serverItems.find((item) => expandedItems.has(item.id))?.id;
      expandedItems.clear();
      if (keep) expandedItems.add(keep);
    }
    for (const [id, setOpen] of itemOpeners) setOpen(isExpanded(id));
  });

  const renderItems = async (items, { force = false } = {}) => {
    serverItems = items;
    itemsShown = true;
    // Rebuilding would drop the name being edited.
    if (renaming) return;
    const serverIds = new Set(items.map((item) => item.id));
    const openedOnly = [...opened.values()].filter((entry) => !serverIds.has(entry.item.id));
    const count = config?.maxItems ? `${items.length}/${config.maxItems}` : String(items.length);
    if (itemCount.textContent !== count) itemCount.textContent = count;
    emptyMessage.hidden = items.length + openedOnly.length > 0;

    // Rebuilding an unchanged list would steal focus and reload previews. Whole
    // items are compared, so an item sent again shows even if it was on top.
    const signature = JSON.stringify([items, [...opened.keys()]]);
    if (!force && signature === renderedSignature) return;
    renderedSignature = signature;

    // Describing encrypted items is async; drop a render overtaken by a newer one.
    const token = ++renderToken;
    const infos = await Promise.all(items.map((item) => mode.describe(item)));
    if (token !== renderToken) return;

    const entries = [
      ...items.map((item, index) => {
        const openedEntry = opened.get(item.id);
        return openedEntry
          ? { item, info: openedEntry.info, opened: openedEntry }
          : { item, info: infos[index] };
      }),
      ...openedOnly.map((entry) => ({ item: entry.item, info: entry.info, opened: entry })),
    ].sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt));

    const mediaEntries = entries.filter(
      (entry) =>
        (entry.info.isImage || entry.info.isVideo || entry.info.isAudio) &&
        (!limitedItem(entry.item) || Boolean(entry.opened)),
    );
    mediaFeed.update(mediaEntries);
    openMediaLink.hidden = mediaEntries.length === 0;
    if (mediaEntries.length) {
      const params = new URLSearchParams(window.location.search);
      params.set("media", mediaEntries[0].item.id);
      const href = `?${params}${window.location.hash}`;
      if (openMediaLink.getAttribute("href") !== href) openMediaLink.setAttribute("href", href);
    }

    // So a busy queue neither reloads previews nor opens and closes them.
    const positions = new Map(items.map((item, index) => [item.id, index + 1]));
    const next = new Map();
    for (const entry of entries) {
      const { id } = entry.item;
      const position = entry.opened ? 0 : (positions.get(id) ?? 0);
      const made = rowState(entry.item, entry.info, entry.opened, canWrite());
      const kept = rows.get(id);
      if (kept && kept.made === made) {
        kept.node.querySelector(".item-position").textContent = position ? String(position) : "";
        next.set(id, kept);
        continue;
      }
      if (kept) freeObjectUrls(id);
      const served = serverRows.get(id);
      next.set(id, {
        made,
        node:
          served?.dataset.made === rowHash(made)
            ? adoptRow(served, entry, position)
            : renderItem(entry, position),
      });
    }
    for (const id of rows.keys()) {
      if (next.has(id)) continue;
      freeObjectUrls(id);
      itemOpeners.delete(id);
    }
    rows = next;
    // Later renders have fresher ages and expiries than the server's.
    if (serverRows.size) {
      serverRows = new Map();
      updateExpiries();
    }
    const nodes = [...next.values()].map((row) => row.node);
    const current = [...itemsList.children];
    if (nodes.length !== current.length || nodes.some((node, index) => node !== current[index])) {
      itemsList.replaceChildren(...nodes);
    }
    queueShown();
  };

  /** Copies a text only when the browser allows it without a tap. */
  let queueShown;
  const firstShown = new Promise((resolve) => {
    queueShown = resolve;
  });

  const copyById = async (id) => {
    const item = serverItems.find((listed) => listed.id === id);
    if (!item) {
      status.error("That item is gone.");
      return;
    }
    if (expandMode === "one") {
      for (const open of expandedItems) itemOpeners.get(open)?.(false);
      expandedItems.clear();
    }
    expandedItems.add(id);
    closedItems.delete(id);
    itemOpeners.get(id)?.(true);
    // Reading it would use it up.
    if (limitedItem(item)) return;
    const info = await mode.describe(item);
    if (info.kind !== "text") return;
    try {
      await copyText(await mode.loadText(item));
      status.success("Copied.");
    } catch {
      status.error("Not copied: this browser wants a tap first. Use copy on the item.");
    }
  };

  return {
    copyById,
    firstShown,
    setMode(value) {
      mode = value;
    },
    setConfig(value) {
      config = value;
    },
    renderItems,
    updateExpiries,
    isItemsShown: () => itemsShown,
    getServerItems: () => serverItems,
  };
};
