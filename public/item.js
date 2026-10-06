// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The page behind a share link, /i/<token>: one item, and nothing that leads
// back to its namespace. Encrypted items carry their own key after the #.
import { button, compactText, copyText, el, element, formatExpiry, request } from "./common.js";
import {
  canCopyImages,
  copyImage,
  describeOpened,
  describePlain,
  downloadBlob,
  itemSummary,
} from "./items.js";
import { openSharedItem } from "./k.mjs";
import { createStatus } from "./status.js";

const title = element("#item-title");
const meta = element("#item-meta");
const section = element("#item");
const body = element("#item-body");
const actions = element("#item-actions");
const status = createStatus(element("#status"));

const keyText = decodeURIComponent(window.location.hash.slice(1));
/** This page is /i/<token>: the contents are at /c, a download at /d. */
const here = window.location.pathname.replace(/\/$/, "");
const GONE = "This item is no longer available.";

/** The same description the namespace page uses, plus how to read the contents. */
const describe = async (item) => {
  if (item.kind !== "sealed") return { ...describePlain(item), decrypt: null };
  if (!keyText) throw new Error("Incomplete link: the part after # is missing.");
  const { metadata, open } = await openSharedItem(keyText, item.metadata, item.size);
  return { ...describeOpened(metadata), decrypt: open };
};

const fetchBytes = async (url, info) => {
  const bytes = await (await request(url, { cache: "no-store" })).arrayBuffer();
  return info.decrypt ? info.decrypt(bytes) : new Uint8Array(bytes);
};

/** Reads the contents; for burn-after-reading items this is the one read. */
const loadContent = async (item, info) => {
  if (info.kind === "text") {
    if (item.text !== undefined) return { text: item.text };
    return { text: new TextDecoder().decode(await fetchBytes(`${here}/c`, info)) };
  }
  const bytes = await fetchBytes(`${here}/c`, info);
  return { blob: new Blob([bytes], { type: info.mime || "application/octet-stream" }) };
};

const showContent = (info, content) => {
  if (content.text !== undefined) {
    body.replaceChildren(el("pre", { textContent: content.text }));
    title.textContent = compactText(content.text).slice(0, 120);
  } else if (info.isImage) {
    body.replaceChildren(el("img", { alt: info.title, src: URL.createObjectURL(content.blob) }));
  } else {
    body.replaceChildren();
  }

  actions.replaceChildren();
  if (content.text !== undefined) {
    actions.append(
      button(
        "Copy",
        async () => {
          try {
            await copyText(content.text);
            status.success("Copied.");
          } catch (error) {
            status.error(error.message);
          }
        },
        undefined,
        "copy",
      ),
    );
  }
  if (info.isImage && canCopyImages()) {
    actions.append(
      button(
        "Copy",
        async () => {
          try {
            await copyImage(content.blob);
            status.success("Copied.");
          } catch (error) {
            status.error(error.message);
          }
        },
        undefined,
        "copy",
      ),
    );
  }
  if (content.blob) {
    actions.append(
      button("Download", () => downloadBlob(content.blob, info.filename), undefined, "download"),
    );
  }
};

const describeMeta = (item, info, opened) => {
  const parts = [itemSummary(item, info)];
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
      button(
        "Open once",
        async () => {
          try {
            const content = await loadContent(item, info);
            describeMeta(item, info, true);
            showContent(info, content);
            status.success("Opened and deleted from the server.");
          } catch (error) {
            status.error(error.message === "Item not found." ? GONE : error.message);
          }
        },
        undefined,
        "burn",
      ),
    );
  } else if (item.kind === "file" && !item.burn) {
    // A plain file: link to it rather than fetching it all just for a button.
    actions.replaceChildren(
      el("a", { className: "button", href: `${here}/d`, textContent: "Download" }),
    );
  } else {
    showContent(info, await loadContent(item, info));
  }
} catch (error) {
  title.textContent = "Shared item";
  status.error(error.message);
}
