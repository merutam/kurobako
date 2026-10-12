// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Most of a page's code, and only colors texts: it loads after the page, and
// texts show plain until it arrives.

let hljs = null;
let loading = null;

export const loadHighlighter = () => {
  loading ??= import("../vendor/highlight.js").then(
    ({ default: loaded }) => {
      hljs = loaded;
      return loaded;
    },
    (error) => {
      // A deployment may have replaced the file: try again next time.
      loading = null;
      throw error;
    },
  );
  return loading;
};

export const highlighter = () => hljs;

export const withHighlighter = (then) => {
  if (hljs) then(hljs);
  else loadHighlighter().then(then, () => {});
};
