// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The page behind a share link, /i/<token>: one item, and nothing that leads
// back to its namespace. Encrypted items carry their own key after the #.
import {
  asPng,
  button,
  compactText,
  copyText,
  dateFormatter,
  element,
  formatBytes,
  formatExpiry,
  HIDDEN_TITLE,
  request,
} from "/common.js";
import { openSharedItem } from "/k.mjs";
import { createStatus } from "/status.js";

const title = element("#item-title");
const meta = element("#item-meta");
const section = element("#item");
const body = element("#item-body");
const actions = element("#item-actions");
const status = createStatus(element("#status"));

const keyText = decodeURIComponent(window.location.hash.slice(1));
const GONE = "This item is no longer available.";

/** The same description the namespace page uses, plus how to read the contents. */
const describe = async (item) => {
  if (item.kind !== "sealed") {
    return {
      kind: item.kind === "text" ? "text" : "file",
      title:
        item.kind === "text" ? (item.burn ? HIDDEN_TITLE : compactText(item.text)) : item.filename,
      filename: item.filename,
      mime: item.mime,
      isImage: item.kind === "image",
      decrypt: null,
    };
  }
  if (!keyText) throw new Error("Incomplete link: the part after # is missing.");
  const { metadata, open } = await openSharedItem(keyText, item.metadata);
  return {
    ...metadata,
    title: metadata.title || HIDDEN_TITLE,
    isImage: metadata.mime?.startsWith("image/") ?? false,
    decrypt: open,
  };
};

const fetchBytes = async (url, info) => {
  const bytes = await (await request(url, { cache: "no-store" })).arrayBuffer();
  return info.decrypt ? info.decrypt(bytes) : new Uint8Array(bytes);
};

/** Reads the contents; for burn-after-reading items this is the one read. */
const loadContent = async (item, info) => {
  if (info.kind === "text") {
    if (item.text !== undefined) return { text: item.text };
    return { text: new TextDecoder().decode(await fetchBytes(item.contentUrl, info)) };
  }
  const bytes = await fetchBytes(item.contentUrl, info);
  return { blob: new Blob([bytes], { type: info.mime || "application/octet-stream" }) };
};

const showContent = (info, content) => {
  if (content.text !== undefined) {
    const pre = document.createElement("pre");
    pre.textContent = content.text;
    body.replaceChildren(pre);
    title.textContent = compactText(content.text).slice(0, 120);
  } else if (info.isImage) {
    const image = document.createElement("img");
    image.alt = info.title;
    image.src = URL.createObjectURL(content.blob);
    body.replaceChildren(image);
  } else {
    body.replaceChildren();
  }

  actions.replaceChildren();
  if (content.text !== undefined) {
    actions.append(
      button("Copy", async () => {
        try {
          await copyText(content.text);
          status.success("Copied.");
        } catch (error) {
          status.error(error.message);
        }
      }),
    );
  }
  if (info.isImage && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    actions.append(
      button("Copy", async () => {
        try {
          const png = await asPng(content.blob);
          await navigator.clipboard.write([new ClipboardItem({ [png.type]: png })]);
          status.success("Copied.");
        } catch (error) {
          status.error(error.message);
        }
      }),
    );
  }
  if (content.blob) {
    const download = document.createElement("a");
    download.href = URL.createObjectURL(content.blob);
    download.download = info.filename || "file";
    download.textContent = "Download";
    download.className = "button";
    actions.append(download);
  }
};

const describeMeta = (item, info, opened) => {
  const kindLabel = info.kind === "text" ? "Text" : info.isImage ? "Image" : "File";
  const parts = [
    kindLabel,
    formatBytes(info.size ?? item.size),
    dateFormatter.format(new Date(item.createdAt)),
  ];
  if (opened && item.burn) parts.push("deleted from the server");
  else if (item.burn) parts.push("deletes when opened");
  if (!opened && item.expiresAt) parts.push(formatExpiry(item.expiresAt));
  if (info.decrypt) parts.unshift("Encrypted");
  meta.textContent = parts.join(" · ");
};

try {
  // The server embeds the item in the page: null once it is gone.
  const item = JSON.parse(element("#item-data").textContent);
  if (!item) throw new Error(GONE);
  const info = await describe(item);

  title.textContent = info.title;
  document.title = `${info.title} · Kurobako`;
  describeMeta(item, info, false);
  section.hidden = false;

  if (item.burn) {
    // Never on page load: link previews and accidental visits must not burn it.
    body.replaceChildren();
    actions.replaceChildren(
      button("Open once", async () => {
        try {
          const content = await loadContent(item, info);
          describeMeta(item, info, true);
          showContent(info, content);
          status.success("Opened and deleted from the server.");
        } catch (error) {
          status.error(error.message === "Item not found." ? GONE : error.message);
        }
      }),
    );
  } else if (item.downloadUrl && !info.isImage) {
    // A plain file: link to it rather than fetching it all just for a button.
    const download = document.createElement("a");
    download.href = item.downloadUrl;
    download.textContent = "Download";
    download.className = "button";
    actions.replaceChildren(download);
  } else {
    showContent(info, await loadContent(item, info));
  }
} catch (error) {
  title.textContent = "Shared item";
  status.error(error.message);
}
