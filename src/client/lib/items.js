// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { BUNDLE_MIME } from "../shared/bundle.js";
import { h } from "../shared/dom.js";
import { describePlain, itemSummary, limitedItem } from "../shared/item-row.js";
import { isShownImage, objectAddress } from "./addresses.js";
import { asPng, HIDDEN_TITLE, SITE } from "./common.js";
import { highlighter, loadHighlighter } from "./highlight.js";

export { describePlain, itemSummary, limitedItem };

export const extensionOf = (title) => /\.([A-Za-z0-9_+-]+)$/.exec(title)?.[1]?.toLowerCase() ?? "";

/** Coloring them would hold up the page. */
export const MAX_HIGHLIGHT_CHARACTERS = 100_000;

/** Without a known extension, no guessing: it colors ordinary words as code. */
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
  // An editor makes a new one on every key.
  else
    loadHighlighter().then(
      (loaded) => code.isConnected && color(loaded),
      () => {},
    );
  return code;
};

/** Including the empty line after a final newline. */
export const lineNumbers = (text) => {
  let count = 1;
  for (const character of text) if (character === "\n") count += 1;
  return Array.from({ length: count }, (_, index) => index + 1).join("\n");
};

export const highlightedText = (text, title) =>
  h(
    "div",
    { class: "numbered-text" },
    h("pre", { class: "line-numbers", "aria-hidden": "true" }, lineNumbers(text)),
    h("pre", {}, highlightedCode(text, title)),
  );

export const describeOpened = (metadata) => ({
  ...metadata,
  title: metadata.title || HIDDEN_TITLE,
  // The type is the sender's word: only what the server would show as an image is one.
  isImage: isShownImage(metadata.mime),
  isVideo: metadata.mime?.startsWith("video/") ?? false,
  isAudio: metadata.mime?.startsWith("audio/") ?? false,
  isBundle: metadata.mime === BUNDLE_MIME,
});

/** Whether a browser plays a format only shows when it tries; if not, a note replaces it. */
export const videoPlayer = (src) => {
  const video = h("video", { src: src, controls: true, preload: "metadata", playsinline: true });
  video.addEventListener("error", () => {
    video.replaceWith(h("p", { class: "hint" }, "This browser can't play this video. Use Save."));
  });
  return video;
};

/** Native controls keep seeking, downloads and accessibility in the browser. */
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

export const canCopyImages = () =>
  Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== "undefined";

/** PNG: the one type every browser takes. */
export const copyImage = async (blob) => {
  if (!canCopyImages()) throw new Error("This browser can't copy images. Use Save.");
  const png = await asPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ [png.type]: png })]);
};

export const downloadBlob = (blob, filename) => {
  const url = objectAddress(blob);
  h("a", { href: url, download: filename || "file" }).click();
  // Long enough for the browser to have started saving it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

/*
 * Through the Service Worker, encrypted contents play and download as they
 * arrive. Without one (some private windows, no HTTPS), pages open them whole.
 */
const streams = new Map();
let streaming = null;

const startStreaming = () => {
  if (streaming) return streaming;
  const workers = globalThis.navigator?.serviceWorker;
  if (!workers) {
    streaming = Promise.resolve(false);
    return streaming;
  }
  // A restarted worker has lost its keys.
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

/** Null without a worker. */
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
