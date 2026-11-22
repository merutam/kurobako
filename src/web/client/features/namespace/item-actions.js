// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What an item's row does: copy, save, share, delete, open once, and the
// addresses its media play from.
import { textDownloadName } from "../../../../sdk/k.mjs";
import { objectAddress, SVG_TYPE, svgAddress } from "../../lib/addresses.js";
import { compactText, copyText, request } from "../../lib/common.js";
import { confirmAction } from "../../lib/dialog.js";
import { copyWithStatus, openedMessage, openFailure } from "../../lib/item-ops.js";
import { downloadBlob, forgetStream, limitedItem, streamAddress } from "../../lib/items.js";

/**
 * An entry is { item, info, opened? }; `opened` holds the contents of an
 * item read once here, after the server deleted it. `onOpened` keeps such
 * contents; `onDeleted` runs once the server deleted an item.
 */
export const createItemActions = ({
  status,
  mode,
  writeHeaders,
  refreshUnlessLive,
  onOpened,
  onDeleted,
}) => {
  /** Freed with their row. */
  const objectUrls = new Map();
  const objectUrl = (blob, id) => {
    const url = objectAddress(blob);
    objectUrls.set(id, [...(objectUrls.get(id) ?? []), url]);
    return url;
  };
  const freeObjectUrls = (id) => {
    for (const url of objectUrls.get(id) ?? []) URL.revokeObjectURL(url);
    objectUrls.delete(id);
  };

  const textOf = (entry) => (entry.opened ? entry.opened.text : mode().loadText(entry.item));
  const blobOf = (entry) => (entry.opened ? entry.opened.blob : mode().loadBlob(entry.item));

  const copy = (entry) =>
    copyWithStatus(status, entry.info.kind === "text" ? textOf(entry) : blobOf(entry));

  /** Burn-after-reading items must be read whole, once. */
  const partsAddress = async (entry) =>
    mode().streamOf && !entry.opened && !limitedItem(entry.item)
      ? streamAddress(await mode().streamOf(entry.item))
      : null;

  /** Decrypted video, audio and SVG go through the Service Worker, which serves them sandboxed. */
  const mediaAddress = async (entry, { preview = false } = {}) => {
    const { item, info } = entry;
    if (!entry.opened && item.kind !== "sealed" && !limitedItem(item)) {
      return {
        src: mode().mediaUrl?.(item) ?? `${mode().basePath}/${encodeURIComponent(item.id)}`,
        revoke: null,
      };
    }
    const isSvg = info.mime === SVG_TYPE;
    const streamed = info.isVideo || info.isAudio || isSvg ? await partsAddress(entry) : null;
    if (streamed) return { src: streamed, revoke: () => forgetStream(streamed) };
    const blob = await blobOf(entry);
    if (isSvg) return { src: svgAddress(new Uint8Array(await blob.arrayBuffer())), revoke: null };
    if (preview) return { src: objectUrl(blob, item.id), revoke: null };
    const src = objectAddress(blob);
    return { src, revoke: () => URL.revokeObjectURL(src) };
  };

  const download = async (entry) => {
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

  const remove = async (entry) => {
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
      await request(`${mode().basePath}/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: writeHeaders(),
      });
      onDeleted(item.id);
      status.success("Deleted.");
      await refreshUnlessLive();
    } catch (error) {
      status.error(error.message);
    }
  };

  /** Encrypted items add their own key after the #, which opens this item only. */
  const share = async (item) => {
    try {
      const response = await request(`${mode().basePath}/${encodeURIComponent(item.id)}/s`, {
        method: "POST",
        headers: writeHeaders(),
      });
      // The server may not know the address this page was opened at.
      const { pathname } = new URL((await response.text()).trim());
      const key = await mode().shareKey(item);
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

  /** Each open uses a read: a second click while the first loads must not. */
  const opening = new Set();
  const openOnce = async (entry) => {
    const { item, info } = entry;
    if (opening.has(item.id)) return;
    opening.add(item.id);
    try {
      const content =
        info.kind === "text"
          ? { text: await mode().loadText(item) }
          : { blob: await mode().loadBlob(item) };
      const title = content.text === undefined ? info.title : compactText(content.text);
      status.success(openedMessage(item));
      await onOpened({ item, info: { ...info, title }, ...content });
    } catch (error) {
      status.error(openFailure(error, "Someone else already opened it."));
      await refreshUnlessLive();
    } finally {
      opening.delete(item.id);
    }
  };

  return {
    textOf,
    blobOf,
    objectUrl,
    freeObjectUrls,
    mediaAddress,
    copy,
    download,
    remove,
    share,
    openOnce,
  };
};
