// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A bundle (see shared/bundle.js), shown: a tab for each of its texts, the
// main one first, and one for its files. A Markdown text shows rendered,
// with the bundle's images in place, and its source a click away.

import { readBundle } from "../shared/bundle.js";
import { h } from "../shared/dom.js";
import { formatBytes } from "../shared/format.js";
import { highlightedText } from "./items.js";
import { isMarkdown, renderMarkdown } from "./markdown.js";

const decoder = new TextDecoder();

/**
 * Tabs over panels: `tabs` are [label, () => panel]; each panel is made on
 * first showing. One tab shows no tab bar at all.
 */
const tabbed = (tabs, { label }) => {
  const panels = new Map();
  const panel = h("div", { class: "tab-panel", role: tabs.length > 1 ? "tabpanel" : undefined });
  const buttons = tabs.map(([name], index) =>
    h("button", { type: "button", role: "tab", "aria-selected": "false", "data-tab": index }, name),
  );
  const show = (index) => {
    for (const [other, button] of buttons.entries()) {
      button.setAttribute("aria-selected", String(other === index));
      button.tabIndex = other === index ? 0 : -1;
    }
    if (!panels.has(index)) panels.set(index, tabs[index][1]());
    panel.replaceChildren(panels.get(index));
  };
  for (const [index, button] of buttons.entries()) {
    button.addEventListener("click", () => show(index));
    // Arrow keys move between tabs, as in any tab list.
    button.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      const next = (index + step + buttons.length) % buttons.length;
      buttons[next].focus();
      show(next);
    });
  }
  show(0);
  return h(
    "div",
    { class: "tabbed" },
    tabs.length > 1
      ? h("div", { class: "tabs", role: "tablist", "aria-label": label }, buttons)
      : null,
    panel,
  );
};

/** A Markdown text, rendered, with a switch to its source. */
const markdownPanel = (text, path, resolve) => {
  const rendered = renderMarkdown(text, { resolve });
  let source = null;
  const toggle = h(
    "button",
    { type: "button", class: "row-action", "aria-pressed": "false" },
    "source",
  );
  const holder = h("div", {}, rendered);
  toggle.addEventListener("click", () => {
    const showSource = toggle.getAttribute("aria-pressed") !== "true";
    source ??= highlightedText(text, path);
    holder.replaceChildren(showSource ? source : rendered);
    toggle.setAttribute("aria-pressed", String(showSource));
  });
  return h("div", { class: "bundle-text" }, h("p", { class: "bundle-tools" }, toggle), holder);
};

/**
 * The view of a bundle's bytes. `objectUrl(blob)` makes the address of one
 * of its files (the caller frees them along with its own).
 */
export const bundleView = (bytes, { objectUrl = (blob) => URL.createObjectURL(blob) } = {}) => {
  const { main, entries } = readBundle(bytes);
  const urls = new Map();
  const urlOf = (entry) => {
    if (!urls.has(entry.path)) {
      urls.set(entry.path, objectUrl(new Blob([entry.bytes], { type: entry.type })));
    }
    return urls.get(entry.path);
  };
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  // A text names a file by its path (assets/photo.png), and only so: what
  // shows here is what any Markdown viewer shows once the tar is extracted.
  const resolve = (path) => {
    const entry = byPath.get(path);
    return entry ? { url: urlOf(entry), type: entry.type, name: entry.path } : null;
  };

  const texts = entries.filter((entry) => entry.text);
  texts.sort((a, b) => (a.path === main ? -1 : b.path === main ? 1 : 0));
  const files = entries.filter((entry) => !entry.text);

  const tabs = texts.map((entry) => [
    entry.path,
    () => {
      const text = decoder.decode(entry.bytes);
      return isMarkdown(entry.path)
        ? markdownPanel(text, entry.path, resolve)
        : highlightedText(text, entry.path);
    },
  ]);
  if (files.length) {
    tabs.push([
      `files (${files.length})`,
      () =>
        h(
          "ul",
          { class: "file-list bundle-files" },
          files.map((entry) =>
            h(
              "li",
              {},
              h(
                "a",
                // Saved under its own name, without the folder.
                { class: "file-name", href: urlOf(entry), download: entry.path.split("/").pop() },
                entry.path,
              ),
              h("span", { class: "file-size" }, formatBytes(entry.bytes.length)),
            ),
          ),
        ),
    ]);
  }
  return h("div", { class: "bundle" }, tabbed(tabs, { label: "Bundle contents" }));
};
