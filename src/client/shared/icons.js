// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The site's few icons: line drawings on a 16×16 grid, drawn here so the
// pages need no icon font or library. Controls are known by their words
// (docs/design.md); icons only mark the theme button's choice and the
// editor's resize handle. They take the text's color and are hidden from
// screen readers: the control around one carries its label.

import { h } from "./dom.js";

/** Each icon as the SVG elements it is made of: [tag, attributes]. */
const ICONS = {
  resize: [["path", { d: "M13 5L5 13M13 9l-4 4M13 12l-1 1" }]],
  sun: [
    ["circle", { cx: "8", cy: "8", r: "2.8" }],
    [
      "path",
      {
        d: "M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1",
      },
    ],
  ],
  moon: [["path", { d: "M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" }]],
  contrast: [
    ["circle", { cx: "8", cy: "8", r: "5.5" }],
    ["path", { d: "M8 2.5v11a5.5 5.5 0 0 0 0-11z", fill: "currentColor" }],
  ],
};

/** The icon `name`, `size` pixels wide and high, as `h` makes it (see dom.js). */
export const iconTree = (h, name, size = 16) =>
  h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.4",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    ICONS[name].map(([tag, attributes]) => h(tag, attributes)),
  );

/** A new <svg> of the icon `name`, `size` pixels wide and high. */
export const icon = (name, size = 16) => iconTree(h, name, size);
