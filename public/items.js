// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Items as the namespace page and the shared-item page show them: what to
// call one, the line under its title, and copying or saving its contents.
import {
  asPng,
  compactText,
  dateFormatter,
  el,
  formatBytes,
  HIDDEN_TITLE,
  SITE,
} from "./common.js";
import hljs from "./vendor/highlight.js";

export const extensionOf = (title) => /\.([A-Za-z0-9_+-]+)$/.exec(title)?.[1]?.toLowerCase() ?? "";
export const languageOf = (title) => {
  const extension = extensionOf(title);
  return extension && hljs.getLanguage(extension) ? extension : null;
};

/** Text as source. A known extension picks its grammar; without one, highlight.js guesses. */
export const highlightedText = (text, title) => {
  const code = el("code");
  const extension = extensionOf(title);
  const language = languageOf(title);
  if (language) {
    code.innerHTML = hljs.highlight(text, { language }).value;
    code.className = `hljs language-${language}`;
  } else if (!extension) {
    const highlighted = hljs.highlightAuto(text);
    code.innerHTML = highlighted.value;
    code.className = `hljs${highlighted.language ? ` language-${highlighted.language}` : ""}`;
  } else {
    code.textContent = text;
    code.className = "hljs";
  }
  return el("pre", {}, code);
};

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

/** Seeks ten seconds toward the half of a video that was activated. */
export const seekVideoAt = (video, clientX) => {
  const bounds = video.getBoundingClientRect();
  const seconds = clientX < bounds.left + bounds.width / 2 ? -10 : 10;
  const end = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
  const target = Math.min(end, Math.max(0, video.currentTime + seconds));
  try {
    if (typeof video.fastSeek === "function") video.fastSeek(target);
    else video.currentTime = target;
  } catch {
    // A stream whose metadata has not arrived yet is not seekable yet.
  }
};

/**
 * A player for a video at `src`. Whether a browser plays a format (MKV,
 * MOV) only shows once it tries: if it cannot, the player gives way to a
 * note, and the download stays.
 */
export const videoPlayer = (src) => {
  const video = el("video", {
    src,
    controls: true,
    preload: "metadata",
    playsInline: true,
    title: "Double-click left or right to seek 10 seconds",
  });
  // Like familiar media viewers: double-click the left or right half to seek.
  video.addEventListener("dblclick", (event) => {
    event.preventDefault();
    seekVideoAt(video, event.clientX);
  });
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

/*
 * Encrypted contents in parts, through the Service Worker (sw.js): it is
 * handed an item's body key and gives an address that plays or downloads
 * the item as it arrives. Without one (some private windows, no HTTPS), the
 * pages open contents whole, as a Blob.
 */
const streams = new Map();
let streaming = null;

/** Whether a Service Worker reads encrypted contents in parts here; started once. */
const startStreaming = () => {
  if (streaming) return streaming;
  const workers = globalThis.navigator?.serviceWorker;
  if (!workers) {
    streaming = Promise.resolve(false);
    return streaming;
  }
  // A worker started again asks for the keys it lost.
  workers.addEventListener("message", (event) => {
    if (event.data?.type === "stream-needed") {
      event.ports[0]?.postMessage({ stream: streams.get(event.data.token) ?? null });
    }
  });
  streaming = (async () => {
    try {
      await workers.register(`${SITE}/sw.js`, { scope: `${SITE}/` });
      await workers.ready;
      // The first time, the worker takes this page over as it activates.
      if (!workers.controller) {
        await new Promise((resolve) => {
          workers.addEventListener("controllerchange", resolve, { once: true });
          setTimeout(resolve, 3000);
        });
      }
      return Boolean(workers.controller);
    } catch {
      return false;
    }
  })();
  return streaming;
};

/**
 * An address that reads encrypted contents in parts, as they arrive; add
 * ?download to save them. `stream` is { url (of the sealed contents), key
 * (the body key), sealedSize, size, mime, filename }. Null without a worker.
 */
export const streamAddress = async (stream) => {
  if (!(await startStreaming())) return null;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  streams.set(token, stream);
  const channel = new MessageChannel();
  const accepted = new Promise((resolve) => {
    channel.port1.onmessage = () => resolve(true);
    setTimeout(() => resolve(false), 2000);
  });
  navigator.serviceWorker.controller?.postMessage({ type: "stream", token, stream }, [
    channel.port2,
  ]);
  return (await accepted) ? `${SITE}/k/stream/${token}` : null;
};
