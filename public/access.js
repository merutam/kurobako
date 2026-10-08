// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Hide write forms before the first paint for an encrypted read-only link.
(() => {
  if (window.location.hash.startsWith("#/")) document.documentElement.dataset.readLink = "";
})();
