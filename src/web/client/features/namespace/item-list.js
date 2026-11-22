// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The queue as rows: rendered once per change, keeping unchanged rows (and
// the server's, at first) with their previews and open state.
import { bundleView } from "../../lib/bundle-view.js";
import { copyText, element, formatAge, formatExpiry } from "../../lib/common.js";
import {
  audioPlayer,
  canCopyImages,
  highlightedText,
  limitedItem,
  videoPlayer,
} from "../../lib/items.js";
import { createMediaFeed } from "../../lib/media-feed.js";
import { h } from "../../shared/dom.js";
import { isMedia, itemRow, localizeDates, rowHash, rowState } from "../../shared/item-row.js";
import { createExpansion } from "./expansion.js";
import { createItemActions } from "./item-actions.js";
import { createRenamer } from "./item-rename.js";

/**
 * `startOpen`: rows show open at first; `numbered: false` leaves out
 * positions (both for a shared item's one row).
 */
export const createItemList = ({
  status,
  access,
  refreshUnlessLive,
  onEdit,
  startOpen = false,
  numbered = true,
}) => {
  const itemsList = element("#items");
  const emptyMessage = element("#empty");
  const itemCount = element("#item-count");
  const openMediaLink = element("#open-media");
  const { canWrite, writeHeaders } = access;
  let config = null;
  let mode = null;
  let renderedSignature = "";
  let renderToken = 0;
  /** Unchanged rows are kept as they are, open or closed, previews loaded. */
  let rows = new Map();

  /* `opened` keeps a burn-after-reading item read here, after the server deletes it. */
  const opened = new Map();
  let serverItems = [];
  let itemsShown = false;

  const expansion = createExpansion({
    choices: element("#expand-mode"),
    order: () => serverItems.map((item) => item.id),
  });
  const actions = createItemActions({
    status,
    mode: () => mode,
    writeHeaders,
    refreshUnlessLive,
    onOpened: async (entry) => {
      opened.set(entry.item.id, entry);
      expansion.keepOpen(entry.item.id);
      await renderItems(serverItems, { force: true });
    },
    onDeleted: (id) => expansion.forget(id),
  });
  const renamer = createRenamer({
    status,
    rename: (item, name) => mode.rename(item, name),
    onCancel: () => renderItems(serverItems),
    onRenamed: refreshUnlessLive,
  });

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

  const mediaFeed = createMediaFeed(actions.mediaAddress);
  openMediaLink.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    mediaFeed.open();
  });

  const dismiss = (id) => {
    opened.delete(id);
    expansion.forget(id);
    void renderItems(serverItems, { force: true });
  };

  /** What an open row shows, loaded on its first opening. */
  const showPreview = async (preview, entry) => {
    const { item, info } = entry;
    if (info.kind === "text") {
      preview.replaceChildren(highlightedText(await actions.textOf(entry), info.title));
    } else if (info.isBundle) {
      const bytes = new Uint8Array(await (await actions.blobOf(entry)).arrayBuffer());
      preview.replaceChildren(
        bundleView(bytes, { objectUrl: (blob) => actions.objectUrl(blob, item.id) }),
      );
    } else {
      // Plain media streams from the server; encrypted video through the Service Worker.
      const { src } = await actions.mediaAddress(entry, { preview: true });
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

    // Opening a burn-after-reading item reads it: only its own button does that.
    if (toggle) {
      const body = listItem.querySelector(".item-body");
      const title = listItem.querySelector(".item-title");
      const preview = listItem.querySelector(".item-preview");
      const previewable = info.kind === "text" || isMedia(info) || info.isBundle;

      let loaded = false;
      const load = async () => {
        if (loaded || !previewable) return;
        loaded = true;
        // A medium the server already put here (a shared item) is not fetched again.
        if (preview.querySelector(":scope > :is(img, video, audio)")) return;
        try {
          await showPreview(preview, entry);
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
      expansion.register(item.id, setOpen);
      const toggleOpen = () => setOpen(expansion.toggle(item.id));
      // The second click of a double-click (a rename) leaves the row as it was.
      toggle.addEventListener("click", (event) => {
        if (event.detail <= 1) toggleOpen();
      });
      if (title.title) {
        title.addEventListener("dblclick", (event) => {
          event.preventDefault();
          toggleOpen();
          renamer.start(entry, title);
        });
      }
      setOpen(expansion.isExpanded(item.id));
    }

    on("open-once", () => actions.openOnce(entry));
    on("media", () => mediaFeed.open(entry));
    on("edit", () => onEdit(entry));
    on("copy", () => actions.copy(entry));
    on("download", () => actions.download(entry));
    on("share", () => actions.share(item));
    on("dismiss", () => dismiss(item.id));
    on("delete", () => actions.remove(entry));
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

  /** Server items, then items read once here that the server no longer lists. */
  const entriesOf = async (items, openedOnly) => {
    const infos = await Promise.all(items.map((item) => mode.describe(item)));
    return [
      ...items.map((item, index) => {
        const openedEntry = opened.get(item.id);
        return openedEntry
          ? { item, info: openedEntry.info, opened: openedEntry }
          : { item, info: infos[index] };
      }),
      ...openedOnly.map((entry) => ({ item: entry.item, info: entry.info, opened: entry })),
    ].sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt));
  };

  const showMedia = (entries) => {
    const mediaEntries = entries.filter(
      (entry) => isMedia(entry.info) && (!limitedItem(entry.item) || Boolean(entry.opened)),
    );
    mediaFeed.update(mediaEntries);
    openMediaLink.hidden = mediaEntries.length === 0;
    if (mediaEntries.length) {
      const params = new URLSearchParams(window.location.search);
      params.set("media", mediaEntries[0].item.id);
      const href = `?${params}${window.location.hash}`;
      if (openMediaLink.getAttribute("href") !== href) openMediaLink.setAttribute("href", href);
    }
  };

  const seen = new Set();
  const renderItems = async (items, { force = false } = {}) => {
    if (startOpen) {
      for (const { id } of items) if (!seen.has(id)) expansion.keepOpen(id);
      for (const { id } of items) seen.add(id);
    }
    serverItems = items;
    itemsShown = true;
    // Rebuilding would drop the name being edited.
    if (renamer.active()) return;
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
    const entries = await entriesOf(items, openedOnly);
    if (token !== renderToken) return;
    showMedia(entries);

    // So a busy queue neither reloads previews nor opens and closes them.
    const positions = new Map(items.map((item, index) => [item.id, numbered ? index + 1 : 0]));
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
      if (kept) actions.freeObjectUrls(id);
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
      actions.freeObjectUrls(id);
      expansion.unregister(id);
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
    expansion.reveal(id);
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
