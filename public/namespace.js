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
  element,
  fileField,
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
} from "./common.js";
import {
  canCopyImages,
  copyImage,
  describeOpened,
  describePlain,
  downloadBlob,
  itemSummary,
} from "./items.js";
import {
  defaultTextName,
  fileMetadata,
  openSealedSpace,
  SEALED_OVERHEAD_BYTES,
  secretNameProblem,
  splitFragment,
} from "./k.mjs";
import { createStatus } from "./status.js";
import { renderSVG } from "./vendor/uqr.js";

const itemsList = element("#items");
const emptyMessage = element("#empty");
const itemCount = element("#item-count");
const status = createStatus(element("#status"));
const textForm = element("#text-form");
const fileForm = element("#file-form");
const textInput = element("#text");
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
const qrImage = element("#qr");
const pageUrl = element("#page-url");
const copyLinkButton = element("#copy-link");
const burnInput = element("#burn");

/** Embedded in the page by the server; see readConfig. */
let config = null;
const expandedItems = new Set();
let renderedSignature = "";
let renderToken = 0;
let objectUrls = [];

// Only rewrites the countdown text; the list itself arrives from the server.
const updateExpiries = () => {
  for (const label of itemsList.querySelectorAll("[data-expires-at]")) {
    label.textContent = formatExpiry(label.dataset.expiresAt);
  }
};

const burnHeaders = (burn) => (burn ? { Burn: "1" } : {});

/*
 * A mode hides how items are stored. Every item is described as
 *   { kind: "text" | "file", title, size, filename?, mime?, isImage }
 * and its content is loaded on demand as text or a Blob. Loading the content
 * of a burn-after-reading item deletes it on the server.
 */
const plainMode = (namespace) => {
  const basePath = `${SITE}/${encodeURIComponent(namespace)}`;
  return {
    basePath,
    title: `/${namespace}`,
    label: "",
    fileOverheadBytes: 0,
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
        headers: { "Content-Type": "text/plain; charset=utf-8", ...burnHeaders(burn) },
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
        },
        body: file,
      }),
    /** An empty name gives a text back its default, the start of its text. */
    rename: (item, name) =>
      request(`${basePath}/${encodeURIComponent(item.id)}/n`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: name,
      }),
  };
};

const sealedMode = async (secretName) => {
  const space = await openSealedSpace(secretName);
  const basePath = `${SITE}/e/${space.id}`;
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
      },
      body,
    });
  };

  return {
    basePath,
    title: `/e#${secretName}`,
    label: "Encrypted",
    fileOverheadBytes: SEALED_OVERHEAD_BYTES,
    shareUrl: `${window.location.origin}${SITE}/e#${encodeURIComponent(secretName)}`,
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
        headers: { "X-Sealed-Metadata": await opened.withMetadata(changes) },
      });
    },
  };
};

const objectUrl = (blob) => {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
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

const downloadItem = async (entry) => {
  try {
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

/** Renames in place: Enter or leaving the field saves, Escape cancels. */
const renameItem = (entry, title) => {
  const holder = title.closest("details") ?? title.parentElement;
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

const renderItem = (entry) => {
  const { item, info } = entry;
  const unopenedBurn = item.burn && !entry.opened;
  const listItem = document.createElement("li");
  listItem.className = "item";

  const title = document.createElement("span");
  title.className = "item-title";
  title.textContent = info.title;
  // Double-click the name to rename it (not an item already read and gone).
  const renamable = !entry.opened && info.kind !== "unreadable";
  if (renamable) {
    title.title = "Double-click to rename";
    title.addEventListener("dblclick", (event) => {
      event.preventDefault();
      renameItem(entry, title);
    });
  }

  const previewable = !unopenedBurn && (info.kind === "text" || info.isImage);
  if (previewable) {
    const details = document.createElement("details");
    details.open = expandedItems.has(item.id);
    const summary = document.createElement("summary");
    summary.append(title);
    const body = document.createElement("div");
    details.append(summary, body);

    let loaded = false;
    const load = async () => {
      if (loaded || !details.open) return;
      loaded = true;
      try {
        if (info.kind === "text") {
          const content = document.createElement("pre");
          content.textContent = await textOf(entry);
          body.replaceChildren(content);
        } else {
          const image = document.createElement("img");
          image.alt = info.title;
          // Plain images load straight from the server; anything else is
          // fetched (and decrypted) here.
          image.src =
            !entry.opened && item.kind === "image" && !item.burn
              ? `${mode.basePath}/${item.id}`
              : objectUrl(await blobOf(entry));
          body.replaceChildren(image);
        }
      } catch (error) {
        loaded = false;
        status.error(error.message);
      }
    };
    // A double-click renames: its second click must not toggle the preview
    // again, and the first one is undone.
    let openBeforeClicks = details.open;
    summary.addEventListener("click", (event) => {
      if (event.detail === 1) openBeforeClicks = details.open;
      else if (renamable && event.target === title) event.preventDefault();
    });
    if (renamable) title.addEventListener("dblclick", () => (details.open = openBeforeClicks));
    details.addEventListener("toggle", () => {
      if (details.open) expandedItems.add(item.id);
      else expandedItems.delete(item.id);
      void load();
    });
    void load();
    listItem.append(details);
  } else {
    const heading = document.createElement("p");
    heading.className = "item-heading";
    heading.append(title);
    listItem.append(heading);
  }

  const meta = document.createElement("p");
  meta.className = "item-meta";
  meta.textContent = itemSummary(item, info);
  if (entry.opened) {
    meta.append(" · ", noteSpan("deleted from the server"));
  } else {
    if (item.burn) meta.append(" · ", noteSpan("deletes when opened"));
    if (item.expiresAt) {
      const expiry = document.createElement("span");
      expiry.dataset.expiresAt = item.expiresAt;
      expiry.textContent = formatExpiry(item.expiresAt);
      meta.append(" · ", expiry);
    }
  }

  const actions = document.createElement("p");
  actions.className = "actions";
  if (unopenedBurn) {
    actions.append(button("Open once", () => openOnce(entry)));
  } else {
    if (info.kind === "text" || (info.isImage && canCopyImages())) {
      actions.append(button("Copy", () => copyItem(entry)));
    }
    if (info.kind === "file") {
      const href = !entry.opened && mode.downloadUrl?.(item);
      if (href) {
        const download = document.createElement("a");
        download.href = href;
        download.textContent = "Download";
        download.className = "button";
        actions.append(download);
      } else {
        // Decrypted (or already consumed) files are fetched only on click.
        actions.append(button("Download", () => downloadItem(entry)));
      }
    }
  }
  if (!entry.opened && info.kind !== "unreadable") {
    actions.append(button("Share", () => shareItem(item)));
  }
  actions.append(
    entry.opened
      ? button("Dismiss", () => dismiss(item.id))
      : button("Delete", () => deleteItem(item), "destructive"),
  );

  listItem.append(meta, actions);
  return listItem;
};

const renderItems = async (items, { force = false } = {}) => {
  serverItems = items;
  itemsShown = true;
  // Rebuilding the list would drop the name being edited; it catches up after.
  if (renaming) return;
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

  const previousUrls = objectUrls;
  objectUrls = [];
  itemsList.replaceChildren(...entries.map(renderItem));
  for (const url of previousUrls) URL.revokeObjectURL(url);
};

/**
 * After a send, delete or rename, the live connection brings the new queue to
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

const setLive = (live) => {
  liveStatus.textContent = live ? "· live" : pausedWhileHidden ? "· paused" : "· offline";
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
    if (message.type === "items") void renderItems(message.items);
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

fileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  if (file.size > fileLimit()) {
    status.error(`File too large. Max ${formatBytes(fileLimit())}.`);
    return;
  }

  setBusy(fileForm, true);
  status.progress("Sending…");
  try {
    const response = await mode.sendFile(file, { burn: burnInput.checked });
    fileForm.reset();
    status.success(await sentMessage(response));
    await refreshUnlessLive();
  } catch (error) {
    status.error(error.message);
  } finally {
    setBusy(fileForm, false);
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
    (await request(`${mode.basePath}/import`, { method: "POST", body: file })).json(),
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
const fileLimit = () => config.maxFileBytes - mode.fileOverheadBytes;

const showPage = () => {
  fileLimitLabel.textContent = `Any file · max ${formatBytes(fileLimit())}`;
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
};

/** Under the text: its characters and its size against the limit, red past it. */
const encoder = new TextEncoder();
let sizeFrame = null;
const showTextSize = () => {
  sizeFrame = null;
  const text = textInput.value;
  const bytes = encoder.encode(text).byteLength;
  let characters = 0;
  for (const _ of text) characters += 1;
  textLimit.textContent = `${numberFormatter.format(characters)} character${characters === 1 ? "" : "s"} · ${formatBytes(bytes)} of ${formatBytes(config.maxTextBytes)}`;
  textLimit.classList.toggle("over", bytes > config.maxTextBytes);
};
// At most once a frame: counting a long text on every key would lag typing.
textInput.addEventListener("input", () => {
  if (sizeFrame === null) sizeFrame = requestAnimationFrame(showTextSize);
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
    const { name: secretName } = splitFragment(window.location.hash.slice(1));
    if (!secretName) {
      throw new Error("Missing name. Open an encrypted namespace from the home page.");
    }
    const problem = secretNameProblem(secretName, config.sealed.maxNameLength);
    if (problem) throw new Error(problem);
    status.progress("Unlocking…");
    mode = await sealedMode(secretName);
    status.clear();
  } else {
    mode = plainMode(decodeURIComponent(path.split("/")[1] || ""));
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
