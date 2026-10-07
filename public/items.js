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
import { icon } from "./icons.js";
import hljs from "./vendor/highlight.js";

export const extensionOf = (title) => /\.([A-Za-z0-9_+-]+)$/.exec(title)?.[1]?.toLowerCase() ?? "";
export const languageOf = (title) => {
  const extension = extensionOf(title);
  return extension && hljs.getLanguage(extension) ? extension : null;
};

/** Longer texts show plain: coloring them would hold up the page. */
export const MAX_HIGHLIGHT_CHARACTERS = 100_000;
/** Guessing a language runs every grammar: over this many characters at most. */
export const DETECTION_CHARACTERS = 10_000;

/**
 * Highlighted source code. A known extension picks its grammar; without one,
 * highlight.js guesses from the text's start, then colors all of it with
 * that one grammar. Very long texts stay plain.
 */
export const highlightedCode = (text, title) => {
  const code = el("code", { className: "hljs" });
  const extension = extensionOf(title);
  const language =
    text.length > MAX_HIGHLIGHT_CHARACTERS
      ? null
      : (languageOf(title) ??
        (extension ? null : hljs.highlightAuto(text.slice(0, DETECTION_CHARACTERS)).language));
  if (language) {
    code.innerHTML = hljs.highlight(text, { language }).value;
    code.className = `hljs language-${language}`;
  } else {
    code.textContent = text;
  }
  return code;
};

/** Text as a complete source block. */
export const highlightedText = (text, title) => el("pre", {}, highlightedCode(text, title));

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

/** How far a double tap, or J and L, seek, in seconds. */
export const SEEK_SECONDS = 10;
/** The longest wait between two taps of a double tap. */
const DOUBLE_TAP_MS = 300;

/** A video given way to a note when this browser cannot play its format. */
const playableOrNote = (video, replaced = video) => {
  video.addEventListener("error", () =>
    replaced.replaceWith(
      el("p", {
        className: "hint",
        textContent: "This browser can't play this video. Use Download.",
      }),
    ),
  );
};

/**
 * A player for a video at `src`: the browser's own, as it is, which every
 * browser plays and controls the same way. Whether a browser plays a format
 * (MKV, MOV) only shows once it tries: if it cannot, the player gives way to
 * a note, and the download stays.
 */
export const videoPlayer = (src) => {
  const video = el("video", { src, controls: true, preload: "metadata", playsInline: true });
  playableOrNote(video);
  return video;
};

/** Moves a video `direction` × SEEK_SECONDS, within its length. */
export const seekVideo = (video, direction) => {
  const end = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
  try {
    video.currentTime = Math.min(end, Math.max(0, video.currentTime + direction * SEEK_SECONDS));
  } catch {
    // Not seekable before its metadata arrives.
  }
};

/**
 * The gallery's player: the browser's, with a layer of our own over the
 * picture (the controls strip below stays the browser's). A tap plays or
 * pauses at once, inside the tap, as browsers require to start playing; a
 * second tap on the same half soon after takes that back and seeks: back 10
 * seconds on the left, ahead on the right. A drag is left to the gallery.
 */
export const gestureVideo = (src) => {
  const video = el("video", { src, controls: true, preload: "metadata", playsInline: true });
  const gestures = el("div", {
    className: "video-gestures",
    title: "Tap to play or pause; double-tap left or right to seek 10 seconds",
  });
  const flash = el("span", { className: "video-seek-flash", ariaHidden: true });
  const player = el("div", { className: "video-player" }, video, gestures, flash);

  let flashTimer = null;
  const seek = (direction) => {
    seekVideo(video, direction);
    flash.textContent = `${direction < 0 ? "−" : "+"}${SEEK_SECONDS} s`;
    flash.dataset.side = direction < 0 ? "left" : "right";
    flash.classList.add("shown");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flash.classList.remove("shown"), 600);
  };
  const toggle = () => {
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };

  let start = null;
  /** The last tap: when and on which half, for a second one to make it a double tap. */
  let last = null;
  gestures.addEventListener("pointerdown", (event) => {
    if (event.isPrimary) start = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  gestures.addEventListener("pointercancel", () => {
    start = null;
  });
  gestures.addEventListener("pointerup", (event) => {
    if (!start || start.id !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12;
    start = null;
    // A drag, not a tap: the gallery's to handle.
    if (moved || (event.pointerType === "mouse" && event.button !== 0)) return;
    const bounds = gestures.getBoundingClientRect();
    const direction = event.clientX < bounds.left + bounds.width / 2 ? -1 : 1;
    const now = performance.now();
    if (last && last.direction === direction && now - last.at <= DOUBLE_TAP_MS) {
      // The first tap played or paused: put that back, then seek.
      toggle();
      seek(direction);
      last = null;
      return;
    }
    toggle();
    last = { direction, at: now };
  });

  playableOrNote(video, player);
  return player;
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

/**
 * An image with the one control images lack: full screen. Videos keep their
 * browser-native controls instead. `fullscreenTarget` may be the image inside
 * a button that opens the gallery.
 */
export const imageFrame = (image, fullscreenTarget = image) => {
  if (typeof fullscreenTarget.requestFullscreen !== "function") return image;
  const button = el(
    "button",
    {
      type: "button",
      className: "image-fullscreen-button",
      ariaLabel: "Full screen",
      title: "Full screen",
    },
    icon("expand"),
  );
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void fullscreenTarget.requestFullscreen().catch(() => {});
  });
  return el("div", { className: "image-frame" }, image, button);
};
