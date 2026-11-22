// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// After load, so it never delays the page. Needed for the share target and encrypted streams.
const base = document.documentElement.dataset.base ?? "";
window.addEventListener("load", () => {
  navigator.serviceWorker?.register(`${base}/sw.js`, { scope: `${base}/` }).catch(() => {});
});
