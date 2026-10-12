// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Loaded media stays loaded, so scrolling back never costs another read.
// Live changes keep untouched cards, so what plays goes on playing.
import { h } from "../shared/dom.js";
import { choiceGroup, element, storage } from "./common.js";
import { audioPlayer, itemSummary, videoPlayer } from "./items.js";

const VIEW_KEY = "kurobako-media-view-v2";
const VIEWS = ["list", "grid", "details"];

export const createMediaFeed = (sourceOf) => {
  const page = element("#media-feed");
  const list = element("#media-feed-list");
  const back = element("#media-feed-back");
  const filterChoices = element("#media-filter");
  const viewChoices = element("#media-view");
  const previousView = { large: "list", grid: "grid", list: "details" }[
    storage.get("kurobako-media-view")
  ];
  const savedView = storage.get(VIEW_KEY) ?? previousView;
  let view = VIEWS.includes(savedView) ? savedView : "list";
  let entries = [];
  let cards = new Map();
  let observer = null;
  let returnScroll = 0;
  let filter = "all";

  list.dataset.view = view;

  const setView = (next) => {
    if (next === view) return;
    view = next;
    list.dataset.view = view;
    storage.set(VIEW_KEY, view);
    for (const card of cards.values()) {
      card.slot.style.removeProperty("min-height");
      const video = card.slot.querySelector("video");
      if (video) {
        if (view === "details") video.pause();
        video.controls = view !== "details";
      }
    }
  };
  choiceGroup(viewChoices, view, setView);
  const matchesFilter = (entry) =>
    filter === "all" ||
    (filter === "images" && entry.info.isImage) ||
    (filter === "videos" && entry.info.isVideo) ||
    (filter === "audios" && entry.info.isAudio);
  const applyFilter = () => {
    for (const card of cards.values()) {
      card.figure.hidden = !matchesFilter(card.entry);
      if (card.figure.hidden) card.slot.querySelector("video, audio")?.pause();
    }
  };
  choiceGroup(filterChoices, filter, (picked) => {
    filter = picked;
    applyFilter();
  });
  const mediaUrl = (id) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("media", id);
    else url.searchParams.delete("media");
    return url;
  };

  const release = (card) => {
    card.generation += 1;
    card.loading = false;
    const medium = card.slot.querySelector("img, video, audio");
    if (medium) {
      card.slot.style.minHeight = `${card.slot.offsetHeight}px`;
      if (medium.localName !== "img") medium.pause();
    }
    card.slot.replaceChildren(h("span", { class: "hint" }, "Scroll to load"));
    card.source?.revoke?.();
    card.source = null;
  };

  const load = async (card) => {
    if (card.source || card.loading) return;
    const generation = ++card.generation;
    card.loading = true;
    card.slot.replaceChildren(h("span", { class: "hint" }, "Loading…"));
    try {
      const source = await sourceOf(card.entry);
      if (generation !== card.generation || page.hidden) {
        source.revoke?.();
        return;
      }
      const medium = card.entry.info.isVideo
        ? videoPlayer(source.src)
        : card.entry.info.isAudio
          ? audioPlayer(source.src)
          : h("img", {
              src: source.src,
              alt: card.entry.info.title,
              loading: "lazy",
              decoding: "async",
            });
      if (medium.localName === "video") medium.controls = view !== "details";
      card.source = source;
      card.slot.replaceChildren(medium);
      card.slot.style.removeProperty("min-height");
    } catch (error) {
      if (generation === card.generation) {
        card.slot.replaceChildren(h("p", { class: "hint" }, error.message));
      }
    } finally {
      if (generation === card.generation) card.loading = false;
    }
  };

  /** When it changes, the card is made again. */
  const signature = (entry) => JSON.stringify([entry.item, entry.info]);

  const makeCard = (entry) => {
    const slot = h(
      "div",
      { class: "media-feed-slot" },
      h("span", { class: "hint" }, "Scroll to load"),
    );
    const caption = h(
      "figcaption",
      {},
      h("span", { class: "media-feed-title", title: entry.info.title }, entry.info.title),
      h("small", { class: "media-feed-meta" }, itemSummary(entry.item, entry.info)),
    );
    const figure = h(
      "figure",
      { class: "media-feed-item", "data-media-id": entry.item.id },
      slot,
      caption,
    );
    observer.observe(figure);
    return {
      entry,
      signature: signature(entry),
      figure,
      slot,
      source: null,
      loading: false,
      generation: 0,
    };
  };

  const forget = (card) => {
    observer?.unobserve(card.figure);
    release(card);
  };

  /** Unchanged cards are kept, loaded and playing; moving a player pauses it. */
  const render = () => {
    observer ??= new IntersectionObserver(
      (changes) => {
        for (const change of changes) {
          const card = cards.get(change.target.dataset.mediaId);
          if (!card) continue;
          if (change.isIntersecting) void load(card);
          else card.slot.querySelector("video")?.pause();
        }
      },
      { rootMargin: "800px 0px" },
    );
    const next = new Map();
    for (const entry of entries) {
      const known = cards.get(entry.item.id);
      if (known?.signature === signature(entry)) {
        known.entry = entry;
        next.set(entry.item.id, known);
        continue;
      }
      if (known) {
        forget(known);
        known.figure.remove();
      }
      next.set(entry.item.id, makeCard(entry));
    }
    for (const [id, card] of cards) {
      if (!next.has(id)) {
        forget(card);
        card.figure.remove();
      }
    }
    cards = next;
    if (!cards.size) {
      list.replaceChildren(h("p", { class: "hint" }, "No media."));
      return;
    }
    list.querySelector(":scope > p.hint")?.remove();
    let index = 0;
    for (const card of cards.values()) {
      const there = list.children[index];
      if (there !== card.figure) list.insertBefore(card.figure, there ?? null);
      index += 1;
    }
    applyFilter();
  };

  const show = () => {
    render();
    const selected = new URL(window.location.href).searchParams.get("media");
    const first = cards.get(selected) ?? cards.values().next().value;
    if (selected) first?.figure.scrollIntoView();
    if (first) void load(first);
  };

  // One medium plays at a time.
  list.addEventListener(
    "play",
    (event) => {
      for (const medium of list.querySelectorAll("audio, video")) {
        if (medium !== event.target) medium.pause();
      }
    },
    true,
  );

  const sync = () => {
    const active = new URL(window.location.href).searchParams.has("media");
    page.hidden = !active;
    document.querySelector("main").classList.toggle("media-feed-open", active);
    back.href = mediaUrl(null).href;
    if (active) {
      show();
    } else {
      for (const card of cards.values()) forget(card);
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
