// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The site's icons: small line drawings on a 16×16 grid, drawn here so the
// pages need no icon font or library. They take the text's color, and are
// hidden from screen readers: the control around one carries its label.

const SVG = "http://www.w3.org/2000/svg";

/** Each icon as the SVG elements it is made of: [tag, attributes]. */
const ICONS = {
  text: [["path", { d: "M3 3.5h10M3 6.5h10M3 9.5h10M3 12.5h6" }]],
  image: [
    ["rect", { x: "2", y: "3", width: "12", height: "10", rx: "1" }],
    ["circle", { cx: "6", cy: "6.5", r: "1.2" }],
    ["path", { d: "M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" }],
  ],
  grid: [
    ["rect", { x: "2", y: "2", width: "5", height: "5", rx: ".5" }],
    ["rect", { x: "9", y: "2", width: "5", height: "5", rx: ".5" }],
    ["rect", { x: "2", y: "9", width: "5", height: "5", rx: ".5" }],
    ["rect", { x: "9", y: "9", width: "5", height: "5", rx: ".5" }],
  ],
  list: [
    ["path", { d: "M5.5 3h8M5.5 8h8M5.5 13h8" }],
    ["path", { d: "M2 3h1M2 8h1M2 13h1" }],
  ],
  json: [
    [
      "path",
      {
        d: "M6 2.5H5a1.5 1.5 0 0 0-1.5 1.5v2A2 2 0 0 1 2 8a2 2 0 0 1 1.5 2v2A1.5 1.5 0 0 0 5 13.5h1M10 2.5h1a1.5 1.5 0 0 1 1.5 1.5v2A2 2 0 0 0 14 8a2 2 0 0 0-1.5 2v2a1.5 1.5 0 0 1-1.5 1.5h-1",
      },
    ],
  ],
  users: [
    ["circle", { cx: "6", cy: "5", r: "2" }],
    ["path", { d: "M2 13v-1a4 4 0 0 1 8 0v1M10 3a2 2 0 0 1 0 4M11 8.5a3.5 3.5 0 0 1 3 3.5v1" }],
  ],
  file: [["path", { d: "M4 1.8h5l3 3v9.4H4zM9 1.8v3h3" }]],
  video: [
    ["rect", { x: "1.5", y: "3.5", width: "13", height: "9", rx: "1" }],
    ["path", { d: "M6.5 6v4l3.5-2z" }],
  ],
  audio: [
    [
      "path",
      {
        d: "M6 11V3l7-1v8M6 5l7-1M6 11a2 1.2 0 1 1-4 0 2 1.2 0 0 1 4 0zM13 10a2 1.2 0 1 1-4 0 2 1.2 0 0 1 4 0z",
      },
    ],
  ],
  /** Deletes when opened. */
  burn: [
    [
      "path",
      {
        d: "M8 1.8c.4 2.2 3.7 3.7 3.7 7.2A3.7 3.7 0 0 1 4.3 9c0-1.5.7-2.4 1.5-3.2.2 1.3.9 2 1.7 2.2C7.2 6 7.4 3.8 8 1.8z",
      },
    ],
  ],
  /** Could not be decrypted. */
  unreadable: [
    ["rect", { x: "3", y: "7", width: "10", height: "7", rx: "1" }],
    ["path", { d: "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" }],
  ],
  copy: [
    ["rect", { x: "5", y: "5", width: "8.5", height: "8.5", rx: "1" }],
    ["path", { d: "M11 5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" }],
  ],
  edit: [["path", { d: "M3 13l2.6-.6L13 5l-2-2-7.4 7.4zM9.8 4.2l2 2" }]],
  resize: [["path", { d: "M13 5L5 13M13 9l-4 4M13 12l-1 1" }]],
  download: [["path", { d: "M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" }]],
  share: [
    [
      "path",
      {
        d: "M6.5 9.5l3-3M7 4.5l1.2-1.2a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L5.5 8",
      },
    ],
  ],
  delete: [["path", { d: "M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" }]],
  dismiss: [["path", { d: "M4 4l8 8M12 4l-8 8" }]],
  send: [["path", { d: "M2 8l11.5-5.5L9 14l-1.5-4.5zM7.5 9.5l6-7" }]],
  /** Restore: a backup goes up. */
  upload: [["path", { d: "M8 10.5v-8M4.5 6L8 2.5 11.5 6M3 13.5h10" }]],
  refresh: [
    ["path", { d: "M13 3v3.5H9.5M3 13V9.5h3.5M12.6 6.5A5 5 0 0 0 3.6 5.5M3.4 9.5a5 5 0 0 0 9 1" }],
  ],
  /** Going into a namespace. */
  open: [["path", { d: "M2.5 8h10M9 4.5L12.5 8 9 11.5" }]],
  random: [
    ["rect", { x: "2.5", y: "2.5", width: "11", height: "11", rx: "2" }],
    ["circle", { cx: "5.5", cy: "5.5", r: ".6" }],
    ["circle", { cx: "8", cy: "8", r: ".6" }],
    ["circle", { cx: "10.5", cy: "10.5", r: ".6" }],
  ],
  login: [
    ["circle", { cx: "5", cy: "8", r: "2.5" }],
    ["path", { d: "M7.5 8h6M11.5 8v2.5M13.5 8v2" }],
  ],
  logout: [["path", { d: "M6.5 2.5h-3v11h3M10 5l3 3-3 3M13 8H6" }]],
  lock: [
    ["rect", { x: "3", y: "7", width: "10", height: "7", rx: "1" }],
    ["path", { d: "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" }],
  ],
  unlock: [
    ["rect", { x: "3", y: "7", width: "10", height: "7", rx: "1" }],
    ["path", { d: "M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" }],
  ],
  /** Others looking: pages open on a namespace. */
  eye: [
    ["path", { d: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" }],
    ["circle", { cx: "8", cy: "8", r: "2" }],
  ],
  /** A link that leaves the site. */
  external: [["path", { d: "M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4" }]],
};

/** A new <svg> of the icon `name`, `size` pixels wide and high. */
export const icon = (name, size = 16) => {
  const svg = document.createElementNS(SVG, "svg");
  for (const [key, value] of Object.entries({
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
  })) {
    svg.setAttribute(key, String(value));
  }
  for (const [tag, attributes] of ICONS[name]) {
    const part = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, value);
    svg.append(part);
  }
  return svg;
};

/** Decorate controls made by JS; SVGs already in initial HTML are left alone. */
export const decorateIcons = (root = document) => {
  for (const control of root.querySelectorAll("[data-icon]")) {
    if (control.firstElementChild?.localName !== "svg") {
      control.prepend(icon(control.dataset.icon));
    }
  }
};
