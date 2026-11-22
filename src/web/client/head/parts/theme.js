// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Classic, in <head>, so the saved theme applies before the first paint. No
// module, so it guards localStorage itself instead of importing common.js.
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
