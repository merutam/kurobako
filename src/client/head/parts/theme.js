// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Loaded as a classic script in <head> so the saved theme applies before the
// first paint. "auto" follows the browser's prefers-color-scheme; the
// header's button goes auto → light → dark and saves the choice. Being no
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
  const saveTheme = (value) => {
    try {
      if (value === "auto") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, value);
    } catch {
      // The choice still applies for this page view.
    }
  };

  const applyTheme = (value) => {
    if (value === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  };

  applyTheme(readTheme());

  const attachToggle = () => {
    const toggle = document.getElementById("theme-toggle");
    const name = document.getElementById("theme-name");
    if (!toggle || !name) return;
    let current = readTheme();
    const show = () => {
      name.textContent = current;
      toggle.dataset.themeChoice = current;
    };
    show();
    toggle.hidden = false;
    toggle.addEventListener("click", () => {
      current = themes[(themes.indexOf(current) + 1) % themes.length];
      applyTheme(current);
      saveTheme(current);
      show();
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachToggle);
  } else {
    attachToggle();
  }
})();
