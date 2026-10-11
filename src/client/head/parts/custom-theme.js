// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A theme made on /k/theme (src/client/pages/theme.js), kept on this device:
// its CSS over the site's, before the first paint. A stylesheet built by
// script, which the site's CSP allows where it refuses a <style> or a blob:
// link. Not on /k/theme itself, so a theme that breaks a page never hides
// the place to mend it.
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
    // An old browser: the site's own theme, then.
  }
})();
