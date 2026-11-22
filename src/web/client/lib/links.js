// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Web addresses in plain text, found after coloring so they work in code too.

import { h } from "../shared/dom.js";

// Quotes and brackets around an address, as in code, are not part of it.
const ADDRESS = /(?<![\w/@.])(?:https?:\/\/|www\.)[^\s<>"'`]*[^\s<>"'`.,:;!?)\]}]/gi;

const hrefOf = (address) => (address.startsWith("www.") ? `https://${address}` : address);

const textNodes = (root) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
};

const wrapAddresses = (root, wrap) => {
  for (const node of textNodes(root)) {
    const text = node.data;
    const parts = [];
    let last = 0;
    for (const match of text.matchAll(ADDRESS)) {
      parts.push(text.slice(last, match.index), wrap(match[0]));
      last = match.index + match[0].length;
    }
    if (!parts.length) continue;
    parts.push(text.slice(last));
    node.replaceWith(...parts.filter(Boolean));
  }
};

export const linkAddresses = (root) =>
  wrapAddresses(root, (address) =>
    h("a", { href: hrefOf(address), target: "_blank", rel: "noopener noreferrer" }, address),
  );

/** For a copy hidden from readers and pointers: looks like a link, takes no focus. */
export const markAddresses = (root) =>
  wrapAddresses(root, (address) => h("span", { class: "text-link" }, address));

export const addressAt = (text, offset) => {
  for (const match of text.matchAll(ADDRESS)) {
    if (match.index <= offset && offset <= match.index + match[0].length) return hrefOf(match[0]);
  }
  return null;
};
