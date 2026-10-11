// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import {
  button,
  compactText,
  copyText,
  dateFormatter,
  el,
  element,
  formatAge,
  formatBytes,
  formatExpiry,
  HIDDEN_TITLE,
  request,
  setBusy,
  storage,
} from "../common.js";
import { h } from "../dom.js";
import { itemRow, rowHash, rowState } from "../item-row.js";
import {
  audioPlayer,
  canCopyImages,
  copyImage,
  downloadBlob,
  extensionOf,
  highlightedText,
  limitedItem,
  streamAddress,
  videoPlayer,
} from "../items.js";
import { defaultTextName, textDownloadName } from "../k.mjs";
import { createMediaFeed } from "../media-feed.js";
import {
  createTextEditor,
  languageOptions,
  MAX_HIGHLIGHT_CHARACTERS,
  withExtension,
} from "../text-editor.js";

export const createItemList = ({ status, access, refreshUnlessLive, loadItems }) => {
  const itemsList = element("#items");
  const emptyMessage = element("#empty");
  const itemCount = element("#item-count");
  const openMediaLink = element("#open-media");
  const expandModeSelect = element("#expand-mode");
  const { canWrite, writeHeaders } = access;
  let config = null;
  /** Items shown open; with "all", the ones closed by hand instead. */
  const expandedItems = new Set();
  const closedItems = new Set();
  /**
   * How items open: "one" at a time (opening one closes the other), "several"
   * at once, or "all" of them. Remembered on this device.
   */
  const EXPAND_MODES = ["one", "several", "all"];
  const EXPAND_MODE_KEY = "kurobako-expand";
  let expandMode = EXPAND_MODES.includes(storage.get(EXPAND_MODE_KEY))
    ? storage.get(EXPAND_MODE_KEY)
    : "one";
  const isExpanded = (id) => (expandMode === "all" ? !closedItems.has(id) : expandedItems.has(id));
  /** Opens or closes a shown item, by id: set when its row is made. */
  const itemOpeners = new Map();
  let renderedSignature = "";
  let renderToken = 0;
  /**
   * The rows shown, by item id, with what they were made from: a row whose
   * item has not changed is kept as it is, open or closed, its preview loaded.
   */
  let rows = new Map();
  /** Blob URLs of previews, by item id: freed when that item's row goes. */
  const objectUrls = new Map();
  const freeObjectUrls = (id) => {
    for (const url of objectUrls.get(id) ?? []) URL.revokeObjectURL(url);
    objectUrls.delete(id);
  };

  // Only rewrites the countdown text; the list itself arrives from the server.
  const updateExpiries = () => {
    for (const label of itemsList.querySelectorAll("[data-expires-at]")) {
      label.textContent = formatExpiry(label.dataset.expiresAt);
    }
    for (const label of itemsList.querySelectorAll("[data-created-at]")) {
      label.textContent = formatAge(label.dataset.createdAt);
    }
  };

  const objectUrl = (blob, id) => {
    const url = URL.createObjectURL(blob);
    objectUrls.set(id, [...(objectUrls.get(id) ?? []), url]);
    return url;
  };

  let mode = null;

  /*
   * The list shows entries: { item, info, opened? }. `opened` holds the content
   * of a burn-after-reading item read here, kept after the server deletes it
   * (and every other viewer loses it) until it is dismissed.
   */
  const opened = new Map();
  let serverItems = [];
  /** Whether the queue has arrived once, by the live connection or a fetch. */
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

  /**
   * An address that reads an encrypted item in parts, through the Service
   * Worker; null when it cannot (no worker, or the item burns after reading,
   * which must be read whole, once).
   */
  const partsAddress = async (entry) =>
    mode.streamOf && !entry.opened && !limitedItem(entry.item)
      ? streamAddress(await mode.streamOf(entry.item))
      : null;

  /**
   * A medium's browser address. Plain media stays streamed from the
   * server. Decrypted media becomes a Blob URL, kept by its row or by the media
   * feed for only as long as it needs it.
   */
  const mediaAddress = async (entry, { preview = false } = {}) => {
    const { item, info } = entry;
    if (!entry.opened && item.kind !== "sealed" && !limitedItem(item)) {
      return {
        src: mode.mediaUrl?.(item) ?? `${mode.basePath}/${encodeURIComponent(item.id)}`,
        revoke: null,
      };
    }
    const streamed = info.isVideo || info.isAudio ? await partsAddress(entry) : null;
    if (streamed) return { src: streamed, revoke: null };
    const blob = await blobOf(entry);
    if (preview) return { src: objectUrl(blob, item.id), revoke: null };
    const src = URL.createObjectURL(blob);
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
      // Saved as it arrives, never whole in this page's memory.
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

  const deleteItem = async (item) => {
    if (!window.confirm("Delete this item?")) return;
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

  /**
   * Copies a link to just this item. The server keeps which namespace the token
   * belongs to; encrypted items add their own key after the #, which the server
   * never sees and which opens this item only.
   */
  const shareItem = async (item) => {
    try {
      const response = await request(`${mode.basePath}/${encodeURIComponent(item.id)}/s`, {
        method: "POST",
        headers: writeHeaders(),
      });
      // The address this page was opened at, which the server may not know.
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
      // Now that it has been read, the title can show what it is.
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

  /** Whether a name is being edited; live updates wait until it is done. */
  let renaming = false;
  /** Whether text contents are being edited; live updates wait until it is done. */
  let editing = false;

  /** Renames in place: Enter or leaving the field saves, Escape cancels. */
  const renameItem = (entry, title) => {
    const holder = title.closest(".item-toggle") ?? title.parentElement;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "rename-input";
    input.setAttribute("aria-label", "New name");
    // An unnamed text starts from its default name; keeping it changes nothing.
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

  /** Opens a text editor in its preview. Save is conditional on the version shown. */
  const editItem = async (entry, preview) => {
    if (editing) return;
    editing = true;
    let original;
    try {
      original = await textOf(entry);
    } catch (error) {
      editing = false;
      status.error(error.message);
      return;
    }

    const form = el("form", { className: "item-editor" });
    const textarea = el("textarea", {
      value: original,
      required: true,
      ariaLabel: "Text contents",
    });
    const initialExtension = extensionOf(entry.info.title);
    const initialLanguage = initialExtension === "txt" ? "" : initialExtension;
    const language = el(
      "select",
      { ariaLabel: "Syntax language" },
      ...languageOptions(initialLanguage),
    );
    language.value = initialLanguage;
    const editor = createTextEditor(textarea, {
      title: () => `source.${language.value || "txt"}`,
    });
    language.addEventListener("change", () => editor.refresh({ immediate: true }));
    const size = el("span", { className: "hint" });
    let sizeTimer = null;
    const showSize = () => {
      sizeTimer = null;
      const bytes = new Blob([textarea.value]).size;
      const paused = textarea.value.length > MAX_HIGHLIGHT_CHARACTERS;
      size.textContent = `${formatBytes(bytes)} / ${formatBytes(config.maxTextBytes)}${paused ? " · highlighting paused" : ""}`;
      size.classList.toggle("error-text", bytes > config.maxTextBytes);
    };
    textarea.addEventListener("input", () => {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(showSize, 300);
    });
    showSize();

    const cancel = button("Cancel", () => {
      editing = false;
      rows.delete(entry.item.id);
      itemOpeners.delete(entry.item.id);
      renderedSignature = "";
      void renderItems(serverItems, { force: true });
    });
    const save = el("button", { type: "submit", className: "primary", textContent: "Save" });
    const toolbar = el("div", { className: "editor-toolbar" }, language, size, editor.position);
    const details = preview.nextElementSibling;
    // Only the date (and the expiry) stays: "Text · 23 B · " goes.
    details.firstChild.remove();
    const footer = el(
      "div",
      { className: "form-footer" },
      details,
      el("span", { className: "actions" }, cancel, save),
    );
    form.append(editor.editor, toolbar, footer);
    preview.replaceChildren(form);
    textarea.focus();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = textarea.value;
      if (new Blob([text]).size > config.maxTextBytes) {
        status.error(`Text too large. Max ${formatBytes(config.maxTextBytes)}.`);
        return;
      }
      const title =
        language.value === initialLanguage
          ? null
          : withExtension(entry.info.title, language.value || "txt");
      setBusy(form, true);
      status.progress("Saving…");
      try {
        await mode.editText(entry.item, text, { original, title });
        editing = false;
        status.success("Saved.");
        renderedSignature = "";
        await loadItems();
      } catch (error) {
        status.error(error.message);
        setBusy(form, false);
      }
    });
  };

  /** What itemRow needs to make an entry's row. */
  const rowOf = (entry, position) => ({
    item: entry.item,
    info: entry.info,
    position,
    opened: Boolean(entry.opened),
    canWrite: canWrite(),
    canCopyImages: canCopyImages(),
    downloadUrl: mode.downloadUrl?.(entry.item) ?? null,
  });

  /**
   * Gives a row (see item-row.js), made here or by the server, its behavior:
   * clicking its toggle opens it, loading its preview, and each action does
   * what its data-action says.
   */
  const wireItem = (listItem, entry) => {
    const { item, info } = entry;
    const on = (action, handler) =>
      listItem.querySelector(`[data-action="${action}"]`)?.addEventListener("click", handler);
    const toggle = listItem.querySelector("button.item-toggle");
    const preview = listItem.querySelector(".item-preview");
    let loadPreview = async () => {};

    // Opening a burn-after-reading item reads it: only its own button does that.
    if (toggle) {
      const body = listItem.querySelector(".item-body");
      const title = listItem.querySelector(".item-title");
      const previewable = info.kind === "text" || info.isImage || info.isVideo || info.isAudio;

      let loaded = false;
      const load = async () => {
        if (loaded || !previewable) return;
        loaded = true;
        try {
          if (info.kind === "text") {
            preview.replaceChildren(highlightedText(await textOf(entry), info.title));
          } else {
            // Plain images and videos load straight from the server (a video
            // in parts, as it plays); an encrypted video plays in parts too,
            // through the Service Worker; anything else is fetched (and
            // decrypted) here, whole.
            const { src } = await mediaAddress(entry, { preview: true });
            if (info.isVideo) {
              preview.replaceChildren(videoPlayer(src));
            } else if (info.isAudio) {
              preview.replaceChildren(audioPlayer(src));
            } else {
              const image = el("img", { alt: info.title, src, draggable: false });
              const open = el(
                "button",
                {
                  type: "button",
                  className: "media-preview",
                  ariaLabel: `Open ${info.title} in media feed`,
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
      loadPreview = load;

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
      // itemRow offers a rename (in the title's tooltip) only to those who can.
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
    on("edit", async () => {
      if (editing) return;
      await loadPreview();
      if (expandMode === "one") {
        for (const id of expandedItems) itemOpeners.get(id)?.(false);
        expandedItems.clear();
      }
      expandedItems.add(item.id);
      closedItems.delete(item.id);
      itemOpeners.get(item.id)?.(true);
      await editItem(entry, preview);
    });
    on("copy", () => copyItem(entry));
    on("download", () => downloadItem(entry));
    on("share", () => shareItem(item));
    on("dismiss", () => dismiss(item.id));
    on("delete", () => deleteItem(item));
  };

  const renderItem = (entry, position) => {
    const listItem = itemRow(h, rowOf(entry, position));
    wireItem(listItem, entry);
    return listItem;
  };

  /**
   * The rows the server rendered (a plain namespace's, a shared view's), by
   * item id: the first render keeps those still made from the same item, as
   * they are, instead of making them again.
   */
  let serverRows = new Map(
    [...itemsList.querySelectorAll("li[data-made]")].map((node) => [node.dataset.id, node]),
  );
  const adoptRow = (node, entry, position) => {
    node.querySelector(".item-position").textContent = position ? String(position) : "";
    // What only this browser knows: whether it copies images, and its own times.
    if (entry.info.isImage && !canCopyImages())
      node.querySelector('[data-action="copy"]')?.remove();
    for (const time of node.querySelectorAll("time[data-local-date]")) {
      time.textContent = dateFormatter.format(new Date(time.dateTime));
    }
    wireItem(node, entry);
    return node;
  };

  expandModeSelect.value = expandMode;
  expandModeSelect.addEventListener("change", () => {
    expandMode = expandModeSelect.value;
    storage.set(EXPAND_MODE_KEY, expandMode);
    closedItems.clear();
    // One at a time keeps the newest of those open.
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
    // Rebuilding the list would drop the name being edited; it catches up after.
    if (renaming || editing) return;
    const serverIds = new Set(items.map((item) => item.id));
    const openedOnly = [...opened.values()].filter((entry) => !serverIds.has(entry.item.id));
    itemCount.textContent = config?.maxItems
      ? `${items.length}/${config.maxItems}`
      : String(items.length);
    emptyMessage.hidden = items.length + openedOnly.length > 0;

    // Refreshing must not rebuild an unchanged list: that would steal focus and
    // reload previews while someone is reading. The whole items count, so an
    // item sent again (new date, maybe a new name) shows even if it was on top.
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
      const url = new URL(window.location.href);
      url.searchParams.set("media", mediaEntries[0].item.id);
      openMediaLink.href = url.href;
    }

    // Rows of unchanged items stay as they are (only their position moves),
    // so a busy queue neither reloads previews nor opens and closes them.
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
    // Only the first render may take the server's rows; ages and expiries in
    // them were the server's, as of when it rendered them.
    if (serverRows.size) {
      serverRows = new Map();
      updateExpiries();
    }
    const nodes = [...next.values()].map((row) => row.node);
    const current = [...itemsList.children];
    if (nodes.length !== current.length || nodes.some((node, index) => node !== current[index])) {
      itemsList.replaceChildren(...nodes);
    }
  };

  return {
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
