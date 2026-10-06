// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Items as the namespace page and the shared-item page show them: what to
// call one, the line under its title, and copying or saving its contents.
import { asPng, compactText, dateFormatter, el, formatBytes, HIDDEN_TITLE } from "./common.js";

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
          item.name ?? (item.burn ? HIDDEN_TITLE : compactText(item.text ?? item.preview ?? "")),
        size: item.size,
        isImage: false,
        isVideo: false,
      }
    : {
        kind: "file",
        title: item.filename,
        filename: item.filename,
        mime: item.mime,
        size: item.size,
        isImage: item.kind === "image",
        isVideo: item.mime?.startsWith("video/") ?? false,
      };

/** An encrypted item, from its opened metadata, in the same shape. */
export const describeOpened = (metadata) => ({
  ...metadata,
  title: metadata.title || HIDDEN_TITLE,
  isImage: metadata.mime?.startsWith("image/") ?? false,
  isVideo: metadata.mime?.startsWith("video/") ?? false,
});

/**
 * A player for a video at `src`. Whether a browser plays a format (MKV,
 * MOV) only shows once it tries: if it cannot, the player gives way to a
 * note, and the download stays.
 */
export const videoPlayer = (src) => {
  const video = el("video", { src, controls: true, preload: "metadata", playsInline: true });
  video.addEventListener("error", () =>
    video.replaceWith(
      el("p", {
        className: "hint",
        textContent: "This browser can't play this video. Use Download.",
      }),
    ),
  );
  return video;
};

/** "Text · 23 B · 10/6/26, 9:10 AM": the start of the line under an item's title. */
export const itemSummary = (item, info) => {
  const kind =
    info.kind === "text" ? "Text" : info.isImage ? "Image" : info.isVideo ? "Video" : "File";
  return `${kind} · ${formatBytes(info.size ?? item.size)} · ${dateFormatter.format(new Date(item.createdAt))}`;
};

/** Whether this browser can put an image on the clipboard. */
export const canCopyImages = () =>
  Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== "undefined";

/** Puts an image on the clipboard, as PNG: the one type every browser takes. */
export const copyImage = async (blob) => {
  if (!canCopyImages()) throw new Error("This browser can't copy images. Use Download.");
  const png = await asPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ [png.type]: png })]);
};

/** Saves contents already in the page under `filename`. */
export const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  el("a", { href: url, download: filename || "file" }).click();
  // Long enough for the browser to have started saving it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
