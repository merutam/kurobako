// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Loaded as a classic script in <head> so the saved theme applies before the
// first paint. "auto" follows the browser's prefers-color-scheme.
(() => {
  const storageKey = "kurobako-theme";
  const themes = [
    { value: "auto", label: "Automatic" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  const readTheme = () => {
    try {
      const saved = localStorage.getItem(storageKey);
      return themes.some((theme) => theme.value === saved) ? saved : "auto";
    } catch {
      return "auto";
    }
  };

  const applyTheme = (value) => {
    if (value === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  };

  applyTheme(readTheme());

  const renderPicker = () => {
    const container = document.querySelector("#appearance");
    if (!container) return;

    // A plain group rather than a fieldset: browsers draw a <legend> on the
    // fieldset's border, which no flex layout can line up with the options.
    const group = document.createElement("div");
    group.className = "appearance";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", "appearance-label");
    const title = document.createElement("span");
    title.id = "appearance-label";
    title.className = "appearance-label";
    title.textContent = "Theme";
    group.append(title);

    const current = readTheme();
    for (const theme of themes) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "theme";
      input.value = theme.value;
      input.checked = theme.value === current;
      input.addEventListener("change", () => {
        applyTheme(theme.value);
        try {
          localStorage.setItem(storageKey, theme.value);
        } catch {
          // The choice still applies for this page view.
        }
      });
      label.append(input, ` ${theme.label}`);
      group.append(label);
    }
    container.replaceChildren(group);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderPicker);
  } else {
    renderPicker();
  }
})();
