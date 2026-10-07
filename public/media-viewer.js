// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The namespace's modal image/video gallery: keyboard and swipe
// navigation, bounded neighbor prefetch, and cleanup of temporary Blob URLs.
// Its videos take taps (play, pause, double-tap to seek) and J and L (seek):
// gestures live here only, where the screen is the gallery's.
import { el, element } from "./common.js";
import { gestureVideo, imageFrame, seekVideo } from "./items.js";

export const createMediaViewer = (sourceOf) => {
  const dialog = element("#media-viewer");
  const title = element("#media-viewer-title");
  const count = element("#media-viewer-count");
  const stage = element("#media-viewer-stage");
  const content = element("#media-viewer-content");

  let entries = [];
  let index = -1;
  let entry = null;
  let load = 0;
  /** The current medium and its two neighbors, already loaded for quick navigation. */
  const cachedMedia = new Map();

  const releaseMedium = ({ source, preloader, medium }) => {
    for (const node of new Set([preloader, medium].filter(Boolean))) {
      // A video comes in its player (see gestureVideo).
      const video = node.localName === "video" ? node : node.querySelector?.("video");
      // An image comes in its frame, with its one custom control.
      const image = node.localName === "img" ? node : node.querySelector?.("img");
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } else {
        (image ?? node).removeAttribute("src");
      }
    }
    source.revoke?.();
  };

  /** Starts fetching and decoding an image, or just a video's metadata. */
  const loadMedium = (nextEntry, current = false) => {
    const { id } = nextEntry.item;
    let pending = cachedMedia.get(id);
    if (!pending) {
      pending = (async () => {
        const source = await sourceOf(nextEntry);
        if (nextEntry.info.isVideo) {
          const preloader = el("video", {
            src: source.src,
            preload: "metadata",
            muted: true,
            playsInline: true,
          });
          preloader.load();
          return { source, preloader, medium: null };
        }
        const preloader = el("img", {
          alt: nextEntry.info.title,
          src: source.src,
          draggable: false,
          decoding: "async",
          fetchPriority: current ? "high" : "low",
        });
        if (typeof preloader.decode === "function") await preloader.decode().catch(() => {});
        return { source, preloader, medium: preloader };
      })();
      cachedMedia.set(id, pending);
      pending.catch(() => {
        if (cachedMedia.get(id) === pending) cachedMedia.delete(id);
      });
    }
    if (current) {
      pending
        .then(({ preloader }) => {
          if (preloader.localName === "img") preloader.fetchPriority = "high";
        })
        .catch(() => {});
    }
    return pending;
  };

  /** Keeps no more than the current, previous and next media in memory. */
  const preloadNeighbors = () => {
    const indexes = new Set([
      index,
      (index - 1 + entries.length) % entries.length,
      (index + 1) % entries.length,
    ]);
    const wanted = new Set([...indexes].map((at) => entries[at]?.item.id));
    for (const [id, pending] of cachedMedia) {
      if (wanted.has(id)) continue;
      cachedMedia.delete(id);
      pending.then(releaseMedium).catch(() => {});
    }

    const current = loadMedium(entry, true);
    for (const at of indexes) {
      const neighbor = entries[at];
      if (neighbor && neighbor !== entry) loadMedium(neighbor).catch(() => {});
    }
    return current;
  };

  const clearMedia = () => {
    for (const pending of cachedMedia.values()) pending.then(releaseMedium).catch(() => {});
    cachedMedia.clear();
  };

  const updateChrome = () => {
    title.textContent = entry?.info.title ?? "Media";
    count.textContent = entries.length ? `${index + 1} / ${entries.length}` : "";
  };

  const focusMedium = () =>
    content.querySelector("video, .image-fullscreen-button")?.focus({ preventScroll: true });

  const show = async (nextIndex, { focus = false } = {}) => {
    if (!entries.length) {
      dialog.close();
      return;
    }
    index = (nextIndex + entries.length) % entries.length;
    entry = entries[index];
    updateChrome();

    const requested = ++load;
    content.querySelector("video")?.pause();
    content.replaceChildren(el("p", { className: "hint", textContent: "Loading…" }));

    try {
      const cached = await preloadNeighbors();
      if (requested !== load || !dialog.open) return;
      if (cached.preloader.localName === "img") cached.preloader.alt = entry.info.title;
      cached.medium =
        cached.preloader.localName === "img"
          ? cached.medium?.classList?.contains("image-frame")
            ? cached.medium
            : imageFrame(cached.preloader)
          : (cached.medium ?? gestureVideo(cached.source.src));
      content.replaceChildren(cached.medium);
      if (focus) focusMedium();
    } catch (error) {
      if (requested === load) {
        content.replaceChildren(
          el("p", { className: "media-viewer-error", textContent: error.message }),
        );
      }
    }
  };

  const move = (offset, focus = false) => {
    if (entries.length > 1) void show(index + offset, { focus });
  };

  const open = (nextEntry) => {
    const nextIndex = entries.findIndex(({ item }) => item.id === nextEntry.item.id);
    if (nextIndex < 0) return;
    if (!dialog.open) dialog.showModal();
    void show(nextIndex);
  };

  const update = (nextEntries) => {
    entries = nextEntries;
    if (!dialog.open) return;
    const current = entries.findIndex(({ item }) => item.id === entry?.item.id);
    if (current >= 0) {
      index = current;
      entry = entries[current];
      updateChrome();
      preloadNeighbors().catch(() => {});
    } else if (entries.length) {
      void show(Math.min(index, entries.length - 1));
    } else {
      dialog.close();
    }
  };

  // Firefox and some desktop window managers return focus to the page body
  // after native full screen. Put it back on the medium so the dialog receives
  // arrow keys again without requiring a click.
  let mediumWasFullscreen = false;
  document.addEventListener("fullscreenchange", () => {
    const fullscreen = document.fullscreenElement;
    if (fullscreen && content.contains(fullscreen)) {
      mediumWasFullscreen = true;
    } else if (!fullscreen && mediumWasFullscreen) {
      mediumWasFullscreen = false;
      if (dialog.open) focusMedium();
    }
  });

  // Keyboard navigation belongs to the open modal, even during the instant
  // in which replacing one medium has left focus on the page body.
  document.addEventListener("keydown", (event) => {
    if (!dialog.open) return;
    // The full-screen medium owns input until the browser returns to the
    // gallery. This avoids changing a hidden item underneath it.
    if (document.fullscreenElement) return;
    const video = content.querySelector("video");
    if (video && (event.key === "j" || event.key === "l") && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      seekVideo(video, event.key === "j" ? -1 : 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(-1, true);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      move(1, true);
    } else if (event.key === "Home" && entries.length > 1) {
      event.preventDefault();
      void show(0, { focus: true });
    } else if (event.key === "End" && entries.length > 1) {
      event.preventDefault();
      void show(entries.length - 1, { focus: true });
    }
  });
  dialog.addEventListener("close", () => {
    load += 1;
    content.querySelector("video")?.pause();
    content.replaceChildren();
    clearMedia();
    entry = null;
    index = -1;
  });

  // A deliberate horizontal drag changes media; vertical touch remains native.
  let pointer = null;
  stage.addEventListener("pointerdown", (event) => {
    if (document.fullscreenElement || !event.isPrimary || event.target.closest("button")) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    // Capturing the pointer over a video would keep its taps (play, seek) and
    // controls from their pointerup. The stage still sees that event during
    // the capture phase, so a swipe there changes media all the same.
    if (!event.target.closest(".video-player")) stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener(
    "pointerup",
    (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const x = event.clientX - pointer.x;
      const y = event.clientY - pointer.y;
      pointer = null;
      if (Math.abs(x) >= 50 && Math.abs(x) > Math.abs(y) * 1.25) move(x < 0 ? 1 : -1);
    },
    true,
  );
  stage.addEventListener("pointercancel", () => {
    pointer = null;
  });

  return { open, update };
};
