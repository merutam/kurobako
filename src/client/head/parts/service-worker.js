// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Every page installs the Service Worker (public/sw.js): it takes what is
// shared to the installed app (the manifest's share_target) and reads
// encrypted contents in parts. Once the page has loaded, so it never delays it.
const base = document.documentElement.dataset.base ?? "";
window.addEventListener("load", () => {
  navigator.serviceWorker?.register(`${base}/sw.js`, { scope: `${base}/` }).catch(() => {});
});
