// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A namespace page's write access, known before its first paint, so that a
// reader never sees the send forms appear and vanish (see namespace.js,
// which takes over once loaded). A classic script in <head>, like theme.js:
// - a read-only link (/e#/<token>) starts as a reader's page, until the
//   namespace says it is open;
// - a key kept on this device for this page (a locked plain namespace's)
//   keeps the forms of a page the server marked locked (data-locked).
(() => {
  const root = document.documentElement;
  if (window.location.hash.startsWith("#/")) root.dataset.readLink = "";
  try {
    if (localStorage.getItem(`kurobako-write:${window.location.pathname}`)) {
      root.dataset.writeKey = "";
    }
  } catch {
    // No storage: no key here.
  }
})();
