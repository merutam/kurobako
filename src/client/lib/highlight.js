// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// highlight.js is most of a page's code and only colors texts, so it loads
// apart, after the page: what it colors shows plain at first and takes its
// colors when it arrives. Pages that color as you type ask for it early
// (loadHighlighter); the rest get it the first time they show a text.

let hljs = null;
let loading = null;

export const loadHighlighter = () => {
  loading ??= import("../vendor/highlight.js").then(
    ({ default: loaded }) => {
      hljs = loaded;
      return loaded;
    },
    (error) => {
      // A deployment since this page loaded may have replaced the file: try
      // again next time; until then texts stay plain.
      loading = null;
      throw error;
    },
  );
  return loading;
};

/** highlight.js, or null until it has arrived. */
export const highlighter = () => hljs;

/** Runs `then` with highlight.js: right away if it is here, or once it arrives. */
export const withHighlighter = (then) => {
  if (hljs) then(hljs);
  else loadHighlighter().then(then, () => {});
};
