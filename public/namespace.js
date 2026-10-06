// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A namespace's page, /<name> or /e#<secret name>: sending texts and files,
// the queue kept live over a WebSocket, sharing, renaming and deleting
// items, a link (and QR code) to open it elsewhere, and its backups. In an
// encrypted namespace everything is encrypted and decrypted here, by k.mjs.
import {
  button,
  compactText,
  copyText,
  el,
  element,
  fileField,
  formatAge,
  formatBytes,
  formatDuration,
  formatExpiry,
  HIDDEN_TITLE,
  ignoreStrayDrops,
  numberFormatter,
  readConfig,
  request,
  restoreForm,
  SITE,
  setBusy,
  storage,
} from "./common.js";
import { icon } from "./icons.js";
import {
  canCopyImages,
  copyImage,
  describeOpened,
  describePlain,
  downloadBlob,
  extensionOf,
  highlightedText,
  itemSummary,
  streamAddress,
  videoPlayer,
} from "./items.js";
import {
  contentSize,
  defaultTextName,
  fileMetadata,
  openReadOnlySpace,
  openSealedSpace,
  secretNameProblem,
  splitFragment,
} from "./k.mjs";
import { createMediaViewer } from "./media-viewer.js";
import { createStatus } from "./status.js";
import {
  createTextEditor,
  languageOptions,
  MAX_HIGHLIGHT_CHARACTERS,
  withExtension,
} from "./text-editor.js";
import { renderSVG } from "./vendor/uqr.js";

const itemsList = element("#items");
const emptyMessage = element("#empty");
const itemCount = element("#item-count");
const status = createStatus(element("#status"));
const textForm = element("#text-form");
const fileForm = element("#file-form");
const textInput = element("#text");
const textLanguage = element("#text-language");
const fileInput = element("#file");
const refreshButton = element("#refresh");
const textLimit = element("#text-limit");
const fileLimitLabel = element("#file-limit");
const backupZip = element("#backup-zip");
const backupTar = element("#backup-tar");
const backupHint = element("#backup-hint");
const restore = element("#restore-form");
const modeLabel = element("#mode-label");
const expiryLabel = element("#expiry-label");
const pageTitle = element("#page-title");
const pageLinks = element("#page-links");
const liveStatus = element("#live-status");
const viewersLabel = element("#viewers");
const qrImage = element("#qr");
const pageUrl = element("#page-url");
const copyLinkButton = element("#copy-link");
const burnInput = element("#burn");
const expandModeSelect = element("#expand-mode");
const sendSection = element("#send-section");
const sendOptions = element(".send-options");
const lockSection = element("#lock-section");
const lockHint = element("#lock-hint");
const lockLinkRow = element("#lock-link-row");
const lockLink = element("#lock-link");
const keyForm = element("#key-form");
const keyInput = element("#key-input");
const lockButton = element("#lock-button");
const unlockButton = element("#unlock-button");
const forgetKeyButton = element("#forget-key");

/** Embedded in the page by the server; see readConfig. */
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

const burnHeaders = (burn) => (burn ? { Burn: "1" } : {});
const versionOf = (item) => item.updatedAt ?? item.createdAt;

/*
 * A mode hides how items are stored. Every item is described as
 *   { kind: "text" | "file", title, size, filename?, mime?, isImage }
 * and its content is loaded on demand as text or a Blob. Loading the content
 * of a burn-after-reading item deletes it on the server.
 */
const plainMode = (namespace) => {
  const basePath = `${SITE}/${encodeURIComponent(namespace)}`;
  const rename = (item, name) =>
    request(`${basePath}/${encodeURIComponent(item.id)}/n`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8", ...writeHeaders() },
      body: name,
    });
  return {
    basePath,
    title: `/${namespace}`,
    label: "",
    /** The largest file a send takes, in bytes of its own contents. */
    fileLimit: (maxFileBytes) => maxFileBytes,
    shareUrl: `${window.location.origin}${basePath}`,
    describe: async (item) => describePlain(item),
    loadText: async (item) =>
      item.text ?? (await request(`${basePath}/${item.id}`, { cache: "no-store" })).text(),
    loadBlob: async (item) =>
      (await request(`${basePath}/${item.id}`, { cache: "no-store" })).blob(),
    downloadUrl: (item) => `${basePath}/${item.id}/d`,
    /** Plain share links need nothing besides the token. */
    shareKey: async () => null,
    sendText: (text, { burn }) =>
      request(`${basePath}/new`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...burnHeaders(burn),
          ...writeHeaders(),
        },
        body: text,
      }),
    sendFile: (file, { burn }) =>
      request(`${basePath}/new`, {
        method: "POST",
        // The server detects images from the bytes; never let a picked .txt
        // file turn into a text item.
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
          ...burnHeaders(burn),
          ...writeHeaders(),
        },
        body: file,
      }),
    editText: async (item, text, { title }) => {
      const response = await request(`${basePath}/${encodeURIComponent(item.id)}/e`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "If-Match": JSON.stringify(versionOf(item)),
          ...writeHeaders(),
        },
        body: text,
      });
      const edited = await response.json();
      return title === null ? edited : (await rename(edited, title)).json();
    },
    /** An empty name gives a text back its default, the start of its text. */
    rename,
  };
};

/** An encrypted namespace, by its secret name or a read-only link's token. */
const sealedMode = async ({ secretName, readToken }) => {
  const space = readToken ? await openReadOnlySpace(readToken) : await openSealedSpace(secretName);
  const basePath = `${SITE}/e/${space.id}`;
  const readOnlyUrl = `${window.location.origin}${SITE}/e#/${space.readToken}`;
  /**
   * Metadata header → its unwrapped key and metadata (a promise; null if
   * unreadable). Keyed on the header, which a rename changes.
   */
  const openedItems = new Map();
  const openItem = (item) => {
    if (!openedItems.has(item.metadata)) {
      openedItems.set(
        item.metadata,
        space.openItem(item.metadata, item.size).catch(() => null),
      );
    }
    return openedItems.get(item.metadata);
  };
  const loadBytes = async (item) => {
    const opened = await openItem(item);
    if (!opened) throw new Error("This item could not be decrypted.");
    const response = await request(`${basePath}/${item.id}`, { cache: "no-store" });
    return opened.open(await response.arrayBuffer());
  };
  const send = async (bytes, metadata, burn) => {
    const { header, body } = await space.sealItem(bytes, metadata);
    return request(`${basePath}/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Sealed-Metadata": header,
        ...burnHeaders(burn),
        ...writeHeaders(),
      },
      body,
    });
  };

  return {
    basePath,
    title: readToken ? "Encrypted namespace" : `/e#${secretName}`,
    label: "Encrypted",
    // The limit counts the sealed body: a tag for every 64 KiB.
    fileLimit: (maxFileBytes) => contentSize(maxFileBytes),
    // Opened by a read-only link, that link is what it passes on.
    shareUrl: readToken
      ? readOnlyUrl
      : `${window.location.origin}${SITE}/e#${encodeURIComponent(secretName)}`,
    /** The key that writes here even locked: the name's; none by a read-only link. */
    writeKey: space.writeKey,
    readOnlyUrl,
    describe: async (item) => {
      const opened = await openItem(item);
      if (!opened) return { kind: "unreadable", title: "(could not decrypt)", size: item.size };
      return describeOpened(opened.metadata);
    },
    loadText: async (item) => new TextDecoder().decode(await loadBytes(item)),
    loadBlob: async (item) => {
      const { metadata } = await openItem(item);
      return new Blob([await loadBytes(item)], {
        type: metadata.mime || "application/octet-stream",
      });
    },
    downloadUrl: null,
    /** What the Service Worker needs to read the item in parts (see streamAddress). */
    streamOf: async (item) => {
      const opened = await openItem(item);
      if (!opened) throw new Error("This item could not be decrypted.");
      return {
        url: `${window.location.origin}${basePath}/${encodeURIComponent(item.id)}`,
        key: await opened.bodyKey(),
        sealedSize: item.size,
        size: opened.metadata.size,
        mime: opened.metadata.mime || "application/octet-stream",
        filename: opened.metadata.filename || "file",
      };
    },
    /** The item's own key, for the part of a share link the server never sees. */
    shareKey: async (item) => (await openItem(item))?.keyText ?? null,
    sendText: (text, { burn }) => {
      const bytes = new TextEncoder().encode(text);
      const title = burn ? "" : defaultTextName(text);
      return send(bytes, { kind: "text", title, size: bytes.byteLength }, burn);
    },
    sendFile: async (file, { burn }) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The same rules as the server's for plain files: images by their bytes.
      return send(bytes, fileMetadata(bytes, file.name), burn);
    },
    editText: async (item, text, { original, title }) => {
      const opened = await openItem(item);
      if (!opened) throw new Error("This item could not be decrypted.");
      if (opened.metadata.kind !== "text") throw new Error("Only texts can be edited.");
      const bytes = new TextEncoder().encode(text);
      const changedTitle =
        title ??
        (opened.metadata.title === defaultTextName(original)
          ? defaultTextName(text)
          : opened.metadata.title);
      const replacement = await opened.withContents(bytes, { title: changedTitle });
      return (
        await request(`${basePath}/${encodeURIComponent(item.id)}/e`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "If-Match": JSON.stringify(versionOf(item)),
            "X-Sealed-Metadata": replacement.header,
            ...writeHeaders(),
          },
          body: replacement.body,
        })
      ).json();
    },
    /**
     * The new name goes into the item's metadata, sealed again with its own
     * key. An empty name gives a text back its default, the start of its text.
     */
    rename: async (item, name) => {
      const opened = await openItem(item);
      if (!opened) throw new Error("This item could not be decrypted.");
      const isText = opened.metadata.kind === "text";
      let changes = { title: name, ...(isText ? {} : { filename: name }) };
      if (isText && !name) {
        changes = {
          title: item.burn ? "" : defaultTextName(new TextDecoder().decode(await loadBytes(item))),
        };
      } else if (!name) {
        throw new Error("A file needs a name.");
      }
      return request(`${basePath}/${encodeURIComponent(item.id)}/n`, {
        method: "POST",
        headers: { "X-Sealed-Metadata": await opened.withMetadata(changes), ...writeHeaders() },
      });
    },
  };
};

const objectUrl = (blob, id) => {
  const url = URL.createObjectURL(blob);
  objectUrls.set(id, [...(objectUrls.get(id) ?? []), url]);
  return url;
};

let mode = null;

/*
 * Write access. A locked namespace is read by anyone and written only with
 * its key, sent as Write-Key. The key is kept on this device, by namespace;
 * an owner's link brings it in its fragment (#w=<key>), never to the server.
 */
let locked = false;
const writeKeyName = () => `kurobako-write:${mode.basePath}`;
/** A plain namespace's key is kept on this device; an encrypted one's comes from its name. */
const writeKey = () => (mode.writeKey !== undefined ? mode.writeKey : storage.get(writeKeyName()));
const writeHeaders = () => (writeKey() ? { "Write-Key": writeKey() } : {});
/** Whether this page may write: an open namespace, or a locked one whose key it has. */
const canWrite = () => !locked || Boolean(writeKey());

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
  mode.streamOf && !entry.opened && !entry.item.burn
    ? streamAddress(await mode.streamOf(entry.item))
    : null;

/**
 * An image or video's browser address. Plain media stays streamed from the
 * server. Decrypted media becomes a Blob URL, kept by its row or by the open
 * viewer for only as long as it needs it.
 */
const mediaAddress = async (entry, { preview = false } = {}) => {
  const { item, info } = entry;
  if (!entry.opened && item.kind !== "sealed" && !item.burn) {
    return { src: `${mode.basePath}/${encodeURIComponent(item.id)}`, revoke: null };
  }
  const streamed = info.isVideo ? await partsAddress(entry) : null;
  if (streamed) return { src: streamed, revoke: null };
  const blob = await blobOf(entry);
  if (preview) return { src: objectUrl(blob, item.id), revoke: null };
  const src = URL.createObjectURL(blob);
  return { src, revoke: () => URL.revokeObjectURL(src) };
};

const mediaViewer = createMediaViewer(mediaAddress);

const downloadItem = async (entry) => {
  try {
    // Saved as it arrives, never whole in this page's memory.
    const address = await partsAddress(entry);
    if (address) {
      window.location.assign(`${address}?download`);
      return;
    }
    downloadBlob(await blobOf(entry), entry.info.filename);
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
    status.success("Opened and deleted from the server.");
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

const noteSpan = (text) => {
  const note = document.createElement("span");
  note.className = "burn-note";
  note.textContent = text;
  return note;
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

/** A button that is only an icon: its label is for screen readers and tooltips. */
const iconButton = (name, label, onClick, className) => {
  const control = button("", onClick, `icon-button${className ? ` ${className}` : ""}`);
  control.append(icon(name));
  control.setAttribute("aria-label", label);
  control.title = label;
  return control;
};

const textInputNext = textInput.nextSibling;
const textInputParent = textInput.parentNode;
textLanguage.replaceChildren(...languageOptions("", { plain: true }));
const mainTextEditor = createTextEditor(textInput, {
  title: () =>
    textLanguage.value && textLanguage.value !== "auto" ? `source.${textLanguage.value}` : "",
  autoDetect: () => textLanguage.value === "auto",
  fullscreenRoot: textForm.querySelector("fieldset"),
  onError: (message) => status.error(message),
});
textInputParent.insertBefore(mainTextEditor.editor, textInputNext);
textLanguage.addEventListener("change", () => mainTextEditor.refresh({ immediate: true }));

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
  const language = el(
    "select",
    { ariaLabel: "Syntax language" },
    ...languageOptions(initialExtension),
  );
  language.value = initialExtension;
  const editor = createTextEditor(textarea, {
    title: () => withExtension(entry.info.title, language.value),
    fullscreenRoot: form,
    onError: (message) => status.error(message),
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
  const controls = el("div", { className: "editor-controls" }, language, size, cancel, save);
  form.append(editor.editor, controls);
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
      language.value === initialExtension ? null : withExtension(entry.info.title, language.value);
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

/**
 * One row per item: its position (1 is the newest, as in $BOX/ns/1), what it
 * is, its name, size and age, and its actions as icons. Clicking the row
 * opens it: the contents of a text or an image, and every detail.
 */
const renderItem = (entry, position) => {
  const { item, info } = entry;
  const unopenedBurn = item.burn && !entry.opened;
  const listItem = el("li", { className: unopenedBurn ? "item burn" : "item" });
  const row = el("div", { className: "item-row" });
  row.append(el("span", { className: "item-position" }, position ? String(position) : ""));

  const kind = unopenedBurn
    ? "burn"
    : info.kind === "unreadable"
      ? "unreadable"
      : info.kind === "text"
        ? "text"
        : info.isImage
          ? "image"
          : info.isVideo
            ? "video"
            : "file";
  const title = el("span", { className: "item-title", textContent: info.title });
  const heading = [el("span", { className: "item-kind" }, icon(kind)), title];
  const age = el("span", { textContent: formatAge(item.createdAt) });
  age.dataset.createdAt = item.createdAt;
  const facts = el(
    "span",
    { className: "item-facts" },
    `${formatBytes(info.size ?? item.size)} · `,
    age,
  );
  let preview = null;
  let loadPreview = async () => {};

  // Opening a burn-after-reading item reads it: only its own button does that.
  const expandable = !unopenedBurn;
  if (!expandable) {
    row.append(el("span", { className: "item-toggle" }, ...heading), facts);
  } else {
    const bodyId = `item-${item.id}`;
    const toggle = el("button", { type: "button", className: "item-toggle" }, ...heading);
    toggle.setAttribute("aria-controls", bodyId);
    const body = el("div", { className: "item-body", id: bodyId });
    const previewable = info.kind === "text" || info.isImage || info.isVideo;
    preview = el("div");

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
          } else {
            const image = el("img", { alt: info.title, src, draggable: false });
            const open = el(
              "button",
              {
                type: "button",
                className: "media-preview",
                ariaLabel: `Open ${info.title} in media viewer`,
                title: "Open media viewer",
              },
              image,
            );
            open.addEventListener("click", () => mediaViewer.open(entry));
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

    const renamable = !entry.opened && info.kind !== "unreadable" && canWrite();
    if (renamable) {
      title.title = "Double-click to rename";
      title.addEventListener("dblclick", (event) => {
        event.preventDefault();
        toggleOpen();
        renameItem(entry, title);
      });
    }

    const details = el("p", { className: "item-meta", textContent: itemSummary(item, info) });
    if (entry.opened) {
      details.append(" · ", noteSpan("deleted from the server"));
    } else if (item.expiresAt) {
      const expiry = el("span", { textContent: formatExpiry(item.expiresAt) });
      expiry.dataset.expiresAt = item.expiresAt;
      details.append(" · ", expiry);
    }
    body.append(preview, details);
    row.append(toggle, facts);
    listItem.append(row, body);
    setOpen(isExpanded(item.id));
  }

  const actions = el("span", { className: "item-actions" });
  if (unopenedBurn) {
    actions.append(button("Open once", () => openOnce(entry), undefined, "burn"));
  } else {
    if (info.isImage || info.isVideo) {
      actions.append(iconButton("expand", "Open media viewer", () => mediaViewer.open(entry)));
    }
    if (!entry.opened && info.kind === "text" && canWrite()) {
      actions.append(
        iconButton(
          "edit",
          "Edit",
          () =>
            void (async () => {
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
            })(),
        ),
      );
    }
    if (info.kind === "text" || (info.isImage && canCopyImages())) {
      actions.append(iconButton("copy", "Copy", () => copyItem(entry)));
    }
    if (info.kind === "file") {
      const href = !entry.opened && mode.downloadUrl?.(item);
      if (href) {
        const download = el(
          "a",
          { href, className: "icon-button", title: "Download" },
          icon("download"),
        );
        download.setAttribute("aria-label", "Download");
        actions.append(download);
      } else {
        // Decrypted (or already consumed) files are fetched only on click.
        actions.append(iconButton("download", "Download", () => downloadItem(entry)));
      }
    }
  }
  // Sharing makes a link on the server: like deleting, it is writing.
  if (!entry.opened && info.kind !== "unreadable" && !unopenedBurn && canWrite()) {
    actions.append(iconButton("share", "Share", () => shareItem(item)));
  }
  if (entry.opened) actions.append(iconButton("dismiss", "Dismiss", () => dismiss(item.id)));
  else if (canWrite()) {
    actions.append(iconButton("delete", "Delete", () => deleteItem(item), "destructive"));
  }
  row.append(actions);
  if (!expandable) listItem.append(row);
  return listItem;
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
  itemCount.textContent = `${items.length}/${config.maxItems}`;
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

  mediaViewer.update(
    entries.filter(
      (entry) =>
        (entry.info.isImage || entry.info.isVideo) && (!entry.item.burn || Boolean(entry.opened)),
    ),
  );

  // Rows of unchanged items stay as they are (only their position moves),
  // so a busy queue neither reloads previews nor opens and closes them.
  const positions = new Map(items.map((item, index) => [item.id, index + 1]));
  const next = new Map();
  for (const entry of entries) {
    const { id } = entry.item;
    const position = entry.opened ? 0 : (positions.get(id) ?? 0);
    const made = JSON.stringify([entry.item, entry.info, Boolean(entry.opened), canWrite()]);
    const kept = rows.get(id);
    if (kept && kept.made === made) {
      kept.node.querySelector(".item-position").textContent = position ? String(position) : "";
      next.set(id, kept);
      continue;
    }
    if (kept) freeObjectUrls(id);
    next.set(id, { made, node: renderItem(entry, position) });
  }
  for (const id of rows.keys()) {
    if (next.has(id)) continue;
    freeObjectUrls(id);
    itemOpeners.delete(id);
  }
  rows = next;
  const nodes = [...next.values()].map((row) => row.node);
  const current = [...itemsList.children];
  if (nodes.length !== current.length || nodes.some((node, index) => node !== current[index])) {
    itemsList.replaceChildren(...nodes);
  }
};

/**
 * After a send, edit, delete or rename, the live connection brings the new queue to
 * every open page, this one included; only without it is the queue fetched.
 */
const isLive = () => socket?.readyState === WebSocket.OPEN;
const refreshUnlessLive = () => (isLive() ? Promise.resolve() : loadItems());
/** How long the first queue may take over the live connection before it is fetched. */
const LIVE_FIRST_QUEUE_MS = 3_000;

const loadItems = async () => {
  refreshButton.disabled = true;
  try {
    const response = await request(`${mode.basePath}/ls?summary`, {
      cache: "no-store",
    });
    setLocked(response.headers.get("locked") === "1");
    await renderItems(await response.json());
  } catch (error) {
    status.error(`Could not refresh: ${error.message}`);
  } finally {
    refreshButton.disabled = false;
  }
};

// The server pushes the whole queue on connect and after every change, over
// a WebSocket that the namespace keeps open while it sleeps. Pings stop
// proxies from closing an idle connection (they are answered without waking
// the server); a dropped connection is retried with a growing delay. A tab
// hidden for a while closes its connection, since every connection and ping
// costs requests, and reconnects (getting the whole queue) when shown.
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
let socket = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_FIRST_MS;
let hiddenTimer = null;
let pausedWhileHidden = false;

/** Others with the namespace open: shown only when there is someone besides this page. */
const showViewers = (count) => {
  if (count <= 1) {
    viewersLabel.replaceChildren();
    return;
  }
  viewersLabel.replaceChildren(
    "· ",
    icon("eye", 14),
    ` ${numberFormatter.format(count)}`,
    el("span", { className: "visually-hidden" }, " connected"),
  );
};

const setLive = (live) => {
  liveStatus.textContent = live ? "· live" : pausedWhileHidden ? "· paused" : "· offline";
  if (!live) showViewers(0);
  liveStatus.classList.toggle("offline", !live && !pausedWhileHidden);
};

const connectLive = () => {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  pausedWhileHidden = false;
  socket?.close();

  const url = new URL(`${mode.basePath}/live`, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const current = new WebSocket(url);
  socket = current;

  current.addEventListener("open", () => {
    setLive(true);
    reconnectDelay = RECONNECT_FIRST_MS;
    pingTimer = setInterval(() => {
      if (current.readyState === WebSocket.OPEN) current.send(config.live.ping);
    }, config.live.pingSeconds * 1000);
  });
  current.addEventListener("message", (event) => {
    if (event.data === config.live.pong) return;
    const message = JSON.parse(event.data);
    if (message.type === "items") {
      setLocked(Boolean(message.locked));
      void renderItems(message.items);
    }
    if (message.type === "viewers") showViewers(message.count);
  });
  current.addEventListener("close", () => {
    if (socket !== current) return;
    clearInterval(pingTimer);
    setLive(false);
    // Never connected long enough to bring the queue: fetch it instead.
    if (!itemsShown) void loadItems();
    // Hidden tabs reconnect when they come back instead.
    if (document.visibilityState !== "visible") return;
    reconnectTimer = setTimeout(connectLive, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  });
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenTimer = setTimeout(() => {
      pausedWhileHidden = true;
      socket?.close(1000, "Tab hidden");
    }, config.live.hiddenCloseSeconds * 1000);
    return;
  }
  clearTimeout(hiddenTimer);
  // Closed (or still closing) while hidden or after a drop: start over.
  if (!socket || socket.readyState >= WebSocket.CLOSING) connectLive();
});

textForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = textInput.value;
  if (new Blob([text]).size > config.maxTextBytes) {
    status.error(`Text too large. Max ${formatBytes(config.maxTextBytes)}.`);
    return;
  }

  setBusy(textForm, true);
  status.progress("Sending…");
  try {
    const response = await mode.sendText(text, { burn: burnInput.checked });
    textInput.value = "";
    mainTextEditor.refresh({ immediate: true });
    showTextSize();
    status.success(await sentMessage(response));
    await refreshUnlessLive();
  } catch (error) {
    status.error(error.message);
  } finally {
    setBusy(textForm, false);
  }
});

/** The same contents already in the queue move to the top instead (200, not 201). */
const sentMessage = async (response) =>
  response.status === 200 && (await response.json()).existing
    ? "Already in the queue: moved to the top."
    : "Sent.";

/**
 * The most files one send takes, by the server's own limits: no more than
 * the queue holds (more would push out what was just sent) nor than it takes
 * in a minute, since each file is a send. 20 if the server says neither.
 */
const maxFiles = () => Math.min(config.maxItems ?? 20, config.sendsPerMinute ?? 20);

/** Waits `seconds`, calling `tick(secondsLeft)` once a second. */
const countdown = async (seconds, tick) => {
  for (let left = seconds; left > 0; left -= 1) {
    tick(left);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

fileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const files = [...fileInput.files];
  if (!files.length) return;
  if (files.length > maxFiles()) {
    status.error(`Too many files: up to ${maxFiles()} at once.`);
    return;
  }
  const tooLarge = files.filter((file) => file.size > fileLimit());
  if (tooLarge.length) {
    status.error(
      `Too large (max ${formatBytes(fileLimit())}): ${tooLarge.map((file) => file.name).join(", ")}.`,
    );
    return;
  }

  setBusy(fileForm, true);
  // The last picked goes first, so the queue, newest on top, lists them as
  // they were picked.
  const queue = files.toReversed();
  let sent = 0;
  let moved = 0;
  try {
    let waits = 0;
    for (let index = 0; index < queue.length; ) {
      status.progress(files.length > 1 ? `Sending ${sent + 1} of ${files.length}…` : "Sending…");
      let response;
      try {
        response = await mode.sendFile(queue[index], { burn: burnInput.checked });
      } catch (error) {
        // Past the sends allowed a minute: wait as the server asks, then go
        // on with the same file. Three waits in a row without a send: stop.
        if (error.status !== 429 || !error.retryAfter || waits >= 3) throw error;
        waits += 1;
        await countdown(error.retryAfter, (left) =>
          status.progress(
            `Send limit reached: going on in ${left} s${files.length > 1 ? ` · ${sent} of ${files.length} sent` : ""}`,
          ),
        );
        continue;
      }
      waits = 0;
      if (response.status === 200 && (await response.json()).existing) moved += 1;
      sent += 1;
      index += 1;
    }
    fileForm.reset();
    status.success(
      files.length === 1
        ? moved
          ? "Already in the queue: moved to the top."
          : "Sent."
        : `Sent ${files.length} files${moved ? ` (${moved} already in the queue, moved to the top)` : ""}.`,
    );
  } catch (error) {
    // Keep only what was not sent, so sending again sends the rest.
    const rest = new DataTransfer();
    for (const file of queue.slice(sent).toReversed()) rest.items.add(file);
    fileInput.files = rest.files;
    fileInput.dispatchEvent(new Event("change"));
    status.error(sent ? `Sent ${sent} of ${files.length}, then: ${error.message}` : error.message);
  } finally {
    setBusy(fileForm, false);
    await refreshUnlessLive();
  }
});

refreshButton.addEventListener("click", loadItems);

// File fields are drop zones that also open the picker when clicked.
fileField(fileInput, element("#file-zone"));
ignoreStrayDrops();

// The server names the file and sends it as a download: the page stays.
backupZip.addEventListener("click", () => window.location.assign(`${mode.basePath}/zip`));
backupTar.addEventListener("click", () => window.location.assign(`${mode.basePath}/tar`));

restoreForm({
  form: restore,
  input: element("#restore-file"),
  zone: element("#restore-zone"),
  status,
  send: async (file) =>
    (
      await request(`${mode.basePath}/import`, {
        method: "POST",
        headers: writeHeaders(),
        body: file,
      })
    ).json(),
  // The live connection brings the new queue; this is for when it is down.
  done: refreshUnlessLive,
});

const copyLink = async () => {
  pageUrl.select();
  try {
    await copyText(mode.shareUrl);
    status.success("Link copied.");
  } catch (error) {
    status.error(error.message);
  }
};
pageUrl.addEventListener("click", copyLink);
copyLinkButton.addEventListener("click", copyLink);

/** Encrypted files grow a little; the server's limit applies to what it receives. */
const fileLimit = () => mode.fileLimit(config.maxFileBytes);

/** Shows what this page may do: send, or only read, and the Lock section's state. */
const showAccess = () => {
  const readOnly = !canWrite();
  sendSection.hidden = readOnly;
  restore.hidden = readOnly;
  // A locked namespace has no items that delete when opened.
  sendOptions.hidden = locked;
  if (locked) burnInput.checked = false;
  modeLabel.textContent = [mode.label, locked ? (readOnly ? "Read-only" : "Locked") : ""]
    .filter(Boolean)
    .map((part) => `${part} · `)
    .join("");

  const key = writeKey();
  const sealed = mode.writeKey !== undefined;
  // Opened by a read-only link: nothing here to lock or unlock.
  lockSection.hidden = sealed && !key;
  lockButton.hidden = locked;
  unlockButton.hidden = !locked || !key;
  // An encrypted namespace's key is its name: nothing to forget or type in.
  forgetKeyButton.hidden = sealed || !key;
  keyForm.hidden = sealed || !locked || Boolean(key);
  lockLinkRow.hidden = !locked || !key;
  if (sealed) {
    lockLink.value = mode.readOnlyUrl;
    lockLink.setAttribute("aria-label", "Read-only link");
    lockHint.textContent = locked
      ? "Locked: the read-only link below opens it for reading only; the name still writes."
      : "Locking keeps it readable with a read-only link, while only the name can send, edit, rename or delete.";
    return;
  }
  lockLink.setAttribute("aria-label", "Link that writes here");
  if (locked && key) {
    lockLink.value = `${mode.shareUrl}#w=${encodeURIComponent(key)}`;
    lockHint.textContent =
      "Locked: anyone can read it, and this device writes. So does the link below: keep it to yourself.";
  } else if (locked) {
    lockHint.textContent =
      "Read-only: only those with its write key can send, edit, rename or delete here.";
  } else {
    lockHint.textContent =
      "Locking keeps it readable by anyone, while only those with its key can send, edit, rename or delete. Only an empty namespace can be locked.";
  }
};

/** The lock as the server says it, from the queue or the live connection. */
const setLocked = (value) => {
  if (value === locked) return;
  locked = value;
  showAccess();
  void renderItems(serverItems, { force: true });
};

lockButton.addEventListener("click", async () => {
  try {
    const response = await request(`${mode.basePath}/lock`, {
      method: "POST",
      headers: writeHeaders(),
    });
    const { writeKey: key } = await response.json();
    if (key) {
      storage.set(writeKeyName(), key);
      status.success("Locked. This device keeps its key; copy the link below to write elsewhere.");
    } else {
      status.success("Locked. Copy the read-only link below to share it for reading.");
    }
    setLocked(true);
    showAccess();
  } catch (error) {
    status.error(error.message);
  }
});

unlockButton.addEventListener("click", async () => {
  if (!window.confirm("Unlock? Anyone with the name could then send, edit, rename and delete."))
    return;
  try {
    await request(`${mode.basePath}/lock`, { method: "DELETE", headers: writeHeaders() });
    if (mode.writeKey === undefined) storage.remove(writeKeyName());
    status.success("Unlocked.");
    setLocked(false);
    showAccess();
  } catch (error) {
    status.error(error.message);
  }
});

forgetKeyButton.addEventListener("click", () => {
  storage.remove(writeKeyName());
  showAccess();
  void renderItems(serverItems, { force: true });
});

keyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  storage.set(writeKeyName(), keyInput.value.trim());
  keyForm.reset();
  status.success("Key saved on this device: writing tells whether it is the right one.");
  showAccess();
  void renderItems(serverItems, { force: true });
});

element("#copy-lock-link").addEventListener("click", async () => {
  try {
    await copyText(lockLink.value);
    status.success(
      mode.writeKey !== undefined
        ? "Read-only link copied."
        : "Link copied: it writes here, keep it to yourself.",
    );
  } catch (error) {
    status.error(error.message);
  }
});

const showPage = () => {
  fileLimitLabel.textContent =
    maxFiles() > 1
      ? `Any files, up to ${maxFiles()} at once · max ${formatBytes(fileLimit())} each`
      : `Any file · max ${formatBytes(fileLimit())}`;
  pageTitle.textContent = mode.title;
  modeLabel.textContent = mode.label ? `${mode.label} · ` : "";
  const link = (href, text) =>
    Object.assign(document.createElement("a"), { href, textContent: text });
  pageLinks.replaceChildren(
    " · ",
    link(`${mode.basePath}/log`, "Access log"),
    " · ",
    // In encrypted mode this shows exactly what the server holds: ciphertext.
    link(`${mode.basePath}/ls`, "See JSON"),
  );
  document.title = `${mode.title} · Kurobako`;
  // Drawn locally: an encrypted link must never be sent to the server.
  qrImage.src = `data:image/svg+xml,${encodeURIComponent(renderSVG(mode.shareUrl, { ecc: "M", border: 2 }))}`;
  pageUrl.value = mode.shareUrl;
  if (mode.label) {
    backupHint.textContent =
      "Every item as a zip or a tar, still encrypted. Items that delete when opened are left out.";
  }
  showAccess();
};

/** Under the text: its characters and its size against the limit, red past it. */
const encoder = new TextEncoder();
let textSizeTimer = null;
const showTextSize = () => {
  clearTimeout(textSizeTimer);
  textSizeTimer = null;
  const text = textInput.value;
  const bytes = encoder.encode(text).byteLength;
  let characters = 0;
  for (const _ of text) characters += 1;
  const paused = text.length > MAX_HIGHLIGHT_CHARACTERS;
  textLimit.textContent = `${numberFormatter.format(characters)} character${characters === 1 ? "" : "s"} · ${formatBytes(bytes)} of ${formatBytes(config.maxTextBytes)}${paused ? " · highlighting paused" : ""}`;
  textLimit.classList.toggle("over", bytes > config.maxTextBytes);
};
// Counting and UTF-8 encoding a long text on every key would lag typing.
textInput.addEventListener("input", () => {
  clearTimeout(textSizeTimer);
  textSizeTimer = setTimeout(showTextSize, 300);
});

const applyConfig = () => {
  textInput.maxLength = config.maxTextBytes;
  showTextSize();
  expiryLabel.textContent = config.itemTtlSeconds
    ? `Expires after ${formatDuration(config.itemTtlSeconds)}`
    : "No expiration";
};

const disableAll = (message) => {
  setBusy(textForm, true);
  setBusy(fileForm, true);
  setBusy(restore, true);
  backupZip.disabled = true;
  backupTar.disabled = true;
  refreshButton.disabled = true;
  status.error(message);
};

// The secret name only exists in the fragment; editing it means another space.
window.addEventListener("hashchange", () => window.location.reload());

try {
  config = readConfig();
  applyConfig();

  // The path inside the site: /e, or /<namespace>.
  const path = window.location.pathname.slice(SITE.length);
  if (path === "/e") {
    // Anything after a "/" is a path for the command-line client (#name/ls).
    // A read-only link is #/<token>.
    const { name: secretName, readToken } = splitFragment(window.location.hash.slice(1));
    if (!secretName && !readToken) {
      throw new Error("Missing name. Open an encrypted namespace from the home page.");
    }
    if (!readToken) {
      const problem = secretNameProblem(secretName, config.sealed.maxNameLength);
      if (problem) throw new Error(problem);
    }
    status.progress("Unlocking…");
    mode = await sealedMode({ secretName, readToken });
    status.clear();
  } else {
    mode = plainMode(decodeURIComponent(path.split("/")[1] || ""));
    // An owner's link: keep its key here, and take it out of the address.
    const ownerKey = /^#w=(.+)$/.exec(window.location.hash)?.[1];
    if (ownerKey) {
      storage.set(writeKeyName(), decodeURIComponent(ownerKey));
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }

  showPage();
  // The live connection brings the queue as it opens; the fetch is the fallback.
  connectLive();
  setTimeout(() => {
    if (!itemsShown) void loadItems();
  }, LIVE_FIRST_QUEUE_MS);
  setInterval(updateExpiries, 30_000);
} catch (error) {
  disableAll(error.message);
}
