// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// h(tag, attributes, ...children): the one way markup shared with the server
// (item-row.js, icons.js) is written. Here it makes elements; the server's h
// (src/pages/components/html.ts) makes the same HTML as text. Attributes are HTML's own
// names: true is an empty attribute, false, null and undefined none at all.
// Children are text, nodes or arrays of them; null, undefined and false are
// left out.

const SVG = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "path", "rect", "circle", "line", "polyline", "polygon", "g"]);

export const h = (tag, attributes = {}, ...children) => {
  const node = SVG_TAGS.has(tag) ? document.createElementNS(SVG, tag) : document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
  node.append(
    ...children
      .flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false),
  );
  return node;
};
