// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Written once for both sides, so the browser can take over the server's rows as they are.
import { BUNDLE_MIME } from "./bundle.js";
import {
  compactText,
  dateFormatter,
  formatAge,
  formatBytes,
  formatExpiry,
  HIDDEN_TITLE,
} from "./format.js";

export const limitedItem = (item) => Boolean(item.burn || item.readsLeft !== undefined);

/** Long texts arrive as a preview; the whole text is fetched when needed. */
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
        isBundle: item.mime === BUNDLE_MIME,
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
          : info.isBundle
            ? "Bundle"
            : "File";

export const itemSummary = (item, info) =>
  `${kindLabel(info)} · ${formatBytes(info.size ?? item.size)} · ${dateFormatter.format(new Date(item.createdAt))}`;

/** The server writes the date in its own zone; the browser rewrites only that <time>. */
export const itemMeta = (h, item, info, opened = false) => {
  const parts = [
    `${kindLabel(info)} · ${formatBytes(info.size ?? item.size)}`,
    h(
      "time",
      { datetime: item.createdAt, "data-local-date": true },
      dateFormatter.format(new Date(item.createdAt)),
    ),
  ];
  if (opened && limitedItem(item))
    parts.push(item.burn || item.readsLeft === 1 ? "deleted from the server" : "one read used");
  else if (limitedItem(item))
    parts.push(item.readsLeft ? `${item.readsLeft} reads left` : "deletes when opened");
  if (!opened && item.expiresAt)
    parts.push(h("span", { "data-expires-at": item.expiresAt }, formatExpiry(item.expiresAt)));
  if (info.decrypt) parts.unshift("Encrypted");
  return parts.flatMap((part, index) => (index ? [" · ", part] : [part]));
};

export const localizeDates = (root) => {
  for (const time of root.querySelectorAll("time[data-local-date]")) {
    const local = dateFormatter.format(new Date(time.dateTime));
    if (time.textContent !== local) time.textContent = local;
  }
};

/** Hashed on server rows (data-made), so the browser can tell which to keep. */
export const rowState = (item, info, opened, canWrite) =>
  JSON.stringify([item, info, Boolean(opened), canWrite]);

/** Short enough for an attribute. */
export const rowHash = (state) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < state.length; index += 1) {
    hash ^= state.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};

const KIND_NAMES = {
  burn: "once",
  unreadable: "locked",
  text: "text",
  image: "image",
  video: "video",
  audio: "audio",
  bundle: "bundle",
  file: "file",
};

/** Closed as made here; the browser opens the ones it should. */
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
              : info.isBundle
                ? "bundle"
                : "file";
  const renamable = expandable && !opened && info.kind !== "unreadable" && canWrite;
  const heading = [
    h("span", { class: "item-kind" }, KIND_NAMES[kind]),
    h("span", { class: "item-title", title: renamable && "Double-click to rename" }, info.title),
  ];
  const facts = h(
    "span",
    { class: "item-facts" },
    `${formatBytes(info.size ?? item.size)} · `,
    h("span", { "data-created-at": item.createdAt }, formatAge(item.createdAt)),
  );

  const actionButton = (label, action, title, className) =>
    h(
      "button",
      {
        type: "button",
        class: className ? `row-action ${className}` : "row-action",
        title,
        "data-action": action,
      },
      label,
    );
  const actionLink = (label, href, title) => h("a", { href, class: "row-action", title }, label);

  const actions = [];
  if (unopenedBurn) {
    actions.push(
      actionButton(
        item.readsLeft ? `open (${item.readsLeft} left)` : "open once",
        "open-once",
        "Opening uses a read",
        "burn-action",
      ),
    );
  } else {
    if (info.isImage || info.isVideo || info.isAudio) {
      actions.push(actionButton("view", "media", "Open in the media feed"));
    }
    if (!opened && (info.kind === "text" || info.isBundle) && canWrite) {
      actions.push(actionButton("edit", "edit", "Edit in the composer"));
    }
    if (info.kind === "text" || (info.isImage && canCopyImages)) {
      actions.push(actionButton("copy", "copy", "Copy to the clipboard"));
    }
    if (info.kind === "file" || info.kind === "text") {
      // Decrypted (or already consumed) files are fetched only on click.
      actions.push(
        !opened && downloadUrl
          ? actionLink("save", downloadUrl, "Save to this device")
          : actionButton("save", "download", "Save to this device"),
      );
    }
  }
  if (!opened && info.itemUrl) actions.push(actionLink("open", info.itemUrl, "Open the item"));
  // Sharing makes a link on the server: like deleting, it is writing.
  if (!opened && info.kind !== "unreadable" && !unopenedBurn && canWrite) {
    actions.push(actionButton("share", "share", "Make a link to share"));
  }
  if (opened) actions.push(actionButton("dismiss", "dismiss", "Remove from this page"));
  else if (canWrite) actions.push(actionButton("delete", "delete", "Delete", "destructive"));

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
