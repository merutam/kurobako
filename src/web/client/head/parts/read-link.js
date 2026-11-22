// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Before the first paint, so a read-only link never flashes write forms.
(() => {
  if (window.location.hash.startsWith("#/")) document.documentElement.dataset.readLink = "";
})();
