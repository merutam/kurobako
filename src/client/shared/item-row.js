// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// An item's row in a list, written once for both sides: the server renders a
// plain namespace's rows with it (src/pages/components/items.tsx), the browser renders
// the rest and takes over the server's rows as they are (namespaces/item-list.js).
// It only describes the markup, through h (see dom.js); what the controls do
// is wired up in the browser, found by their data-action.
import {
  compactText,
  dateFormatter,
  formatAge,
  formatBytes,
  formatExpiry,
  HIDDEN_TITLE,
} from "./format.js";
import { iconTree } from "./icons.js";

export const limitedItem = (item) => Boolean(item.burn || item.readsLeft !== undefined);

/**
 * A plain item, as the pages show it: { kind: "text" | "file", title,
 * filename?, mime?, size, isImage, isVideo }. A text goes by its name, or by its start
 * (long texts arrive as a preview; the whole text is fetched when needed).
 */
export const describePlain = (item) =>
  item.kind === "text"
    ? {
        kind: "text",
        title:
          item.name ??
          (limitedItem(item) ? HIDDEN_TITLE : compactText(item.text ?? item.preview ?? "")),
        size: item.size,
        isImage: false,
        isVideo: false,
        isAudio: false,
      }
    : {
        kind: "file",
        title: item.filename,
        filename: item.filename,
        mime: item.mime,
        size: item.size,
        isImage: item.kind === "image",
        isVideo: item.mime?.startsWith("video/") ?? false,
        isAudio: item.mime?.startsWith("audio/") ?? false,
      };

const kindLabel = (info) =>
  info.kind === "text"
    ? "Text"
    : info.isImage
      ? "Image"
      : info.isVideo
        ? "Video"
        : info.isAudio
          ? "Audio"
          : "File";

/** "Text · 23 B · 10/6/26, 9:10 AM": the start of the line under an item's title. */
export const itemSummary = (item, info) =>
  `${kindLabel(info)} · ${formatBytes(info.size ?? item.size)} · ${dateFormatter.format(new Date(item.createdAt))}`;

/**
 * Everything a row is made from, as text: a row is made again only when this
 * changes. The server puts its hash on the rows it renders (data-made), so the
 * browser can tell which it can keep.
 */
export const rowState = (item, info, opened, canWrite) =>
  JSON.stringify([item, info, Boolean(opened), canWrite]);

/** 32-bit FNV-1a, in hex: short enough for an attribute. */
export const rowHash = (state) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < state.length; index += 1) {
    hash ^= state.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};

/**
 * One row per item: its position (1 is the newest, as in $BOX/ns/1), what it
 * is, its name, size and age, and its actions as icons. The row's toggle opens
 * its body: the contents of a text or an image, and every detail. Closed, as
 * made here; the browser opens the ones it should.
 *
 * `opened` is set for a burn-after-reading item read on this page;
 * `downloadUrl` is where to download it straight from the server, if anywhere;
 * `made`, the server's rowHash.
 */
export const itemRow = (
  h,
  { item, info, position, opened = false, canWrite, canCopyImages, downloadUrl, made },
) => {
  const unopenedBurn = limitedItem(item) && !opened;
  const expandable = !unopenedBurn;
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
            : info.isAudio
              ? "audio"
              : "file";
  const renamable = expandable && !opened && info.kind !== "unreadable" && canWrite;
  const heading = [
    h("span", { class: "item-kind" }, iconTree(h, kind)),
    h("span", { class: "item-title", title: renamable && "Double-click to rename" }, info.title),
  ];
  const facts = h(
    "span",
    { class: "item-facts" },
    `${formatBytes(info.size ?? item.size)} · `,
    h("span", { "data-created-at": item.createdAt }, formatAge(item.createdAt)),
  );

  /** A button that is only an icon: its label is for screen readers and tooltips. */
  const iconButton = (name, label, action, className) =>
    h(
      "button",
      {
        type: "button",
        class: className ? `icon-button ${className}` : "icon-button",
        "aria-label": label,
        title: label,
        "data-action": action,
      },
      iconTree(h, name),
    );
  const iconLink = (name, label, href) =>
    h("a", { href, class: "icon-button", title: label, "aria-label": label }, iconTree(h, name));

  const actions = [];
  if (unopenedBurn) {
    actions.push(
      h(
        "button",
        { type: "button", "data-action": "open-once" },
        iconTree(h, "burn"),
        item.readsLeft ? `Open (${item.readsLeft} left)` : "Open once",
      ),
    );
  } else {
    if (info.isImage || info.isVideo || info.isAudio) {
      const media = info.isVideo ? "video" : info.isAudio ? "audio" : "image";
      actions.push(iconButton(media, "Open media feed", "media"));
    }
    if (!opened && info.kind === "text" && canWrite) {
      actions.push(iconButton("edit", "Edit", "edit"));
    }
    if (info.kind === "text" || (info.isImage && canCopyImages)) {
      actions.push(iconButton("copy", "Copy", "copy"));
    }
    if (info.kind === "file" || info.kind === "text") {
      // Decrypted (or already consumed) files are fetched only on click.
      actions.push(
        !opened && downloadUrl
          ? iconLink("download", "Download", downloadUrl)
          : iconButton("download", "Download", "download"),
      );
    }
  }
  if (!opened && info.itemUrl) actions.push(iconLink("external", "Open item", info.itemUrl));
  // Sharing makes a link on the server: like deleting, it is writing.
  if (!opened && info.kind !== "unreadable" && !unopenedBurn && canWrite) {
    actions.push(iconButton("share", "Share", "share"));
  }
  if (opened) actions.push(iconButton("dismiss", "Dismiss", "dismiss"));
  else if (canWrite) actions.push(iconButton("delete", "Delete", "delete", "destructive"));

  const bodyId = `item-${item.id}`;
  const row = h(
    "div",
    { class: "item-row" },
    h("span", { class: "item-position" }, position ? String(position) : ""),
    expandable
      ? h(
          "button",
          {
            type: "button",
            class: "item-toggle",
            "aria-controls": bodyId,
            "aria-expanded": "false",
          },
          heading,
        )
      : h("span", { class: "item-toggle" }, heading),
    facts,
    h("span", { class: "item-actions" }, actions),
  );
  const note = item.burn || item.readsLeft === 1 ? "deleted from the server" : "one read used";
  const body =
    expandable &&
    h(
      "div",
      { class: "item-body", id: bodyId, hidden: true },
      h("div", { class: "item-preview" }),
      h(
        "p",
        { class: "item-meta" },
        `${kindLabel(info)} · ${formatBytes(info.size ?? item.size)} · `,
        h(
          "time",
          { datetime: item.createdAt, "data-local-date": true },
          dateFormatter.format(new Date(item.createdAt)),
        ),
        opened
          ? [" · ", h("span", { class: "burn-note" }, note)]
          : item.expiresAt
            ? [
                " · ",
                h("span", { "data-expires-at": item.expiresAt }, formatExpiry(item.expiresAt)),
              ]
            : null,
      ),
    );
  return h(
    "li",
    { class: unopenedBurn ? "item burn" : "item", "data-id": item.id, "data-made": made },
    row,
    body,
  );
};
