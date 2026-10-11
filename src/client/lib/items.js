// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { BUNDLE_MIME } from "../shared/bundle.js";
// Items as the namespace page and the shared-item page show them: what to
// call one, the line under its title, and copying or saving its contents.
import { h } from "../shared/dom.js";
import { describePlain, itemSummary, limitedItem } from "../shared/item-row.js";
import { isShownImage, objectAddress } from "./addresses.js";
import { asPng, HIDDEN_TITLE, SITE } from "./common.js";
import { highlighter, loadHighlighter } from "./highlight.js";

export { describePlain, itemSummary, limitedItem };

export const extensionOf = (title) => /\.([A-Za-z0-9_+-]+)$/.exec(title)?.[1]?.toLowerCase() ?? "";

/** Longer texts show plain: coloring them would hold up the page. */
export const MAX_HIGHLIGHT_CHARACTERS = 100_000;

/**
 * Highlighted source code. A known extension picks its grammar; without one
 * the text stays plain, as text: a guess colors ordinary words ("from", "a")
 * as code. Very long texts stay plain too. The code shows plain until
 * highlight.js is here (see highlight.js), then takes its colors.
 */
export const highlightedCode = (text, title) => {
  const code = h("code", { class: "hljs" }, text);
  if (text.length > MAX_HIGHLIGHT_CHARACTERS || !extensionOf(title)) return code;
  const color = (hljs) => {
    const extension = extensionOf(title);
    const language = hljs.getLanguage(extension) && extension;
    if (!language) return;
    code.innerHTML = hljs.highlight(text, { language }).value;
    code.className = `hljs language-${language}`;
  };
  const hljs = highlighter();
  if (hljs) color(hljs);
  // Only if still shown by then: an editor makes a new one on every key.
  else
    loadHighlighter().then(
      (loaded) => code.isConnected && color(loaded),
      () => {},
    );
  return code;
};

/** One number per source line, including the empty line after a final newline. */
export const lineNumbers = (text) => {
  let count = 1;
  for (const character of text) if (character === "\n") count += 1;
  return Array.from({ length: count }, (_, index) => index + 1).join("\n");
};

/** Text as a complete source block, numbered in the namespace and share pages. */
export const highlightedText = (text, title) =>
  h(
    "div",
    { class: "numbered-text" },
    h("pre", { class: "line-numbers", "aria-hidden": "true" }, lineNumbers(text)),
    h("pre", {}, highlightedCode(text, title)),
  );

/** An encrypted item, from its opened metadata, in the same shape. */
export const describeOpened = (metadata) => ({
  ...metadata,
  title: metadata.title || HIDDEN_TITLE,
  // The type is the sender's word: only what the server would show as an
  // image is shown as one.
  isImage: isShownImage(metadata.mime),
  isVideo: metadata.mime?.startsWith("video/") ?? false,
  isAudio: metadata.mime?.startsWith("audio/") ?? false,
  isBundle: metadata.mime === BUNDLE_MIME,
});

/**
 * A player for a video at `src`: the browser's own, as it is, which every
 * browser plays and controls the same way. Whether a browser plays a format
 * (MKV, MOV) only shows once it tries: if it cannot, the player gives way to
 * a note, and the download stays.
 */
export const videoPlayer = (src) => {
  const video = h("video", { src: src, controls: true, preload: "metadata", playsinline: true });
  video.addEventListener("error", () => {
    video.replaceWith(h("p", { class: "hint" }, "This browser can't play this video. Use Save."));
  });
  return video;
};

/** Native audio controls keep seeking, downloads and accessibility in the browser. */
/**
 * The browser's own audio player, with the file's cover picture above it when
 * it has one (read from its tag by cover.js, which loads only for audio).
 */
export const audioPlayer = (src) => {
  const cover = h("img", { class: "audio-cover", alt: "", hidden: true });
  const audio = h("audio", { src, controls: true, preload: "metadata", playsinline: true });
  void import("./cover.js")
    .then(({ coverOf }) => coverOf(src))
    .then(
      (picture) => {
        if (!picture) return;
        const url = objectAddress(picture);
        cover.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
        cover.src = url;
        cover.hidden = false;
      },
      () => {},
    );
  return h("div", { class: "audio-player" }, cover, audio);
};

/** Whether this browser can put an image on the clipboard. */
export const canCopyImages = () =>
  Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== "undefined";

/** Puts an image on the clipboard, as PNG: the one type every browser takes. */
export const copyImage = async (blob) => {
  if (!canCopyImages()) throw new Error("This browser can't copy images. Use Save.");
  const png = await asPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ [png.type]: png })]);
};

/** Saves contents already in the page under `filename`. */
export const downloadBlob = (blob, filename) => {
  const url = objectAddress(blob);
  h("a", { href: url, download: filename || "file" }).click();
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
