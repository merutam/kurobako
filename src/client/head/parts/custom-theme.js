// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A stylesheet built by script: the CSP refuses <style> and blob: links. Not on
// /k/theme, so a theme that breaks pages never hides the place to mend it.
(() => {
  const base = document.documentElement.dataset.base ?? "";
  if (window.location.pathname.replace(/\/$/, "") === `${base}/k/theme`) return;
  let css = null;
  try {
    css = localStorage.getItem("kurobako-custom-theme");
  } catch {
    return;
  }
  if (!css || !("adoptedStyleSheets" in document)) return;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    // After the site's own, so the same selectors win.
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // An old browser keeps the site's own theme.
  }
})();
