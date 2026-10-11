// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Loaded as a classic script in <head> so the saved theme applies before the
// first paint. "auto" follows the browser's prefers-color-scheme. Being no
// module, it cannot import common.js, so it guards localStorage itself.
(() => {
  const storageKey = "kurobako-theme";
  const themes = ["auto", "light", "dark"];

  const readTheme = () => {
    try {
      const saved = localStorage.getItem(storageKey);
      return themes.includes(saved) ? saved : "auto";
    } catch {
      return "auto";
    }
  };

  const applyTheme = (value) => {
    if (value === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  };

  applyTheme(readTheme());

  const attachPicker = () => {
    const current = readTheme();
    for (const input of document.querySelectorAll('input[name="theme"]')) {
      input.checked = input.value === current;
      input.addEventListener("change", () => {
        applyTheme(input.value);
        try {
          localStorage.setItem(storageKey, input.value);
        } catch {
          // The choice still applies for this page view.
        }
      });
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachPicker);
  } else {
    attachPicker();
  }
})();
