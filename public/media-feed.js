// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A scrollable media page. Only media near the viewport is loaded; decrypted
// Blob URLs are released again as the reader scrolls away.
import { el, element, storage } from "./common.js";
import { itemSummary, videoPlayer } from "./items.js";

const VIEW_KEY = "kurobako-media-view-v2";
const VIEWS = ["list", "grid", "details"];
const GRID_ROW_HEIGHT = 320;

export const createMediaFeed = (sourceOf) => {
  const page = element("#media-feed");
  const list = element("#media-feed-list");
  const back = element("#media-feed-back");
  const viewButtons = [...page.querySelectorAll("[data-media-view]")];
  const previousView = { large: "list", grid: "grid", list: "details" }[
    storage.get("kurobako-media-view")
  ];
  const savedView = storage.get(VIEW_KEY) ?? previousView;
  let view = VIEWS.includes(savedView) ? savedView : "list";
  let entries = [];
  let cards = new Map();
  const aspects = new Map();
  let observer = null;
  let returnScroll = 0;

  list.dataset.view = view;
  for (const button of viewButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.mediaView === view));
  }

  const setView = (next) => {
    if (next === view) return;
    view = next;
    list.dataset.view = view;
    storage.set(VIEW_KEY, view);
    for (const button of viewButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.mediaView === view));
    }
    for (const card of cards.values()) {
      card.slot.style.removeProperty("min-height");
      const video = card.slot.querySelector("video");
      if (video) {
        if (view === "details") video.pause();
        video.controls = view !== "details";
      }
    }
  };
  for (const button of viewButtons) {
    button.addEventListener("click", () => setView(button.dataset.mediaView));
  }
  const mediaUrl = (id) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("media", id);
    else url.searchParams.delete("media");
    return url;
  };

  const release = (card) => {
    card.generation += 1;
    card.loading = false;
    const medium = card.slot.querySelector("img, video");
    if (medium) {
      card.slot.style.minHeight = `${card.slot.offsetHeight}px`;
      if (medium.localName === "video") medium.pause();
    }
    card.slot.replaceChildren(el("span", { className: "hint", textContent: "Scroll to load" }));
    card.source?.revoke?.();
    card.source = null;
  };

  const rememberAspect = (card, width, height) => {
    if (!(width > 0 && height > 0)) return;
    const ratio = width / height;
    aspects.set(card.entry.item.id, ratio);
    card.figure.style.setProperty("--media-ratio", String(ratio));
    card.figure.style.setProperty("--media-basis", `${ratio * GRID_ROW_HEIGHT}px`);
  };

  const load = async (card) => {
    if (card.source || card.loading) return;
    const generation = ++card.generation;
    card.loading = true;
    card.slot.replaceChildren(el("span", { className: "hint", textContent: "Loading…" }));
    try {
      const source = await sourceOf(card.entry);
      if (generation !== card.generation || page.hidden) {
        source.revoke?.();
        return;
      }
      const medium = card.entry.info.isVideo
        ? videoPlayer(source.src)
        : el("img", {
            src: source.src,
            alt: card.entry.info.title,
            loading: "lazy",
            decoding: "async",
          });
      if (medium.localName === "video") {
        medium.controls = view !== "details";
        medium.addEventListener("loadedmetadata", () => {
          if (generation === card.generation) {
            rememberAspect(card, medium.videoWidth, medium.videoHeight);
          }
        });
        if (medium.videoWidth) rememberAspect(card, medium.videoWidth, medium.videoHeight);
      } else {
        medium.addEventListener("load", () => {
          if (generation === card.generation) {
            rememberAspect(card, medium.naturalWidth, medium.naturalHeight);
          }
        });
        if (medium.complete) rememberAspect(card, medium.naturalWidth, medium.naturalHeight);
      }
      card.source = source;
      card.slot.replaceChildren(medium);
      card.slot.style.removeProperty("min-height");
    } catch (error) {
      if (generation === card.generation) {
        card.slot.replaceChildren(el("p", { className: "hint", textContent: error.message }));
      }
    } finally {
      if (generation === card.generation) card.loading = false;
    }
  };

  const render = () => {
    observer?.disconnect();
    for (const card of cards.values()) release(card);
    cards = new Map();
    list.replaceChildren();
    if (!entries.length) {
      list.append(el("p", { className: "hint", textContent: "No images or videos." }));
      return;
    }
    observer = new IntersectionObserver(
      (changes) => {
        for (const change of changes) {
          const card = cards.get(change.target.dataset.mediaId);
          if (!card) continue;
          if (change.isIntersecting) void load(card);
          else if (card.source || card.loading) release(card);
        }
      },
      { rootMargin: "800px 0px" },
    );
    for (const entry of entries) {
      const slot = el(
        "div",
        { className: "media-feed-slot" },
        el("span", { className: "hint", textContent: "Scroll to load" }),
      );
      const caption = el(
        "figcaption",
        {},
        el("span", {
          className: "media-feed-title",
          textContent: entry.info.title,
          title: entry.info.title,
        }),
        el("small", {
          className: "media-feed-meta",
          textContent: itemSummary(entry.item, entry.info),
        }),
      );
      const figure = el("figure", { className: "media-feed-item" }, slot, caption);
      figure.dataset.mediaId = entry.item.id;
      list.append(figure);
      const card = {
        entry,
        figure,
        slot,
        source: null,
        loading: false,
        generation: 0,
      };
      const knownAspect = aspects.get(entry.item.id);
      if (knownAspect) rememberAspect(card, knownAspect, 1);
      cards.set(entry.item.id, card);
      observer.observe(figure);
    }
    const selected = new URL(window.location.href).searchParams.get("media");
    const first = cards.get(selected) ?? cards.values().next().value;
    if (selected) first?.slot.parentElement.scrollIntoView();
    if (first) void load(first);
  };

  const sync = () => {
    const active = new URL(window.location.href).searchParams.has("media");
    page.hidden = !active;
    document.querySelector("main").classList.toggle("media-feed-open", active);
    back.href = mediaUrl(null).href;
    if (active) {
      render();
    } else {
      observer?.disconnect();
      for (const card of cards.values()) release(card);
      cards.clear();
      list.replaceChildren();
    }
  };

  const open = (entry = entries[0]) => {
    if (!entry) return;
    if (page.hidden) returnScroll = window.scrollY;
    window.history.pushState(null, "", mediaUrl(entry.item.id));
    sync();
  };

  back.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    window.history.pushState(null, "", mediaUrl(null));
    sync();
    window.scrollTo(0, returnScroll);
  });
  window.addEventListener("popstate", sync);

  const update = (nextEntries) => {
    const changed =
      JSON.stringify(nextEntries.map(({ item, info }) => [item, info])) !==
      JSON.stringify(entries.map(({ item, info }) => [item, info]));
    entries = nextEntries;
    if (changed && !page.hidden) render();
  };

  sync();
  return { open, update };
};
