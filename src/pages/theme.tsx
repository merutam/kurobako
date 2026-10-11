// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// One's own theme, on this device: the site's tokens.css to edit, seen on
// the page as it is typed, then kept in the browser (src/client/pages/theme.js)
// and laid over every other page before it shows (head/parts/custom-theme.js).
import { ASSETS_PATH, TOKENS } from "../assets";
import { Page, type SiteView } from "./components/layout";

export const renderThemePage = (site: SiteView) => {
  const tokens = site.manifest.files[TOKENS];
  if (!tokens) throw new Error("The bundle has no tokens.");
  const presets = site.manifest.themes;
  return Page({
    site,
    title: "Theme · Kurobako",
    scripts: ["theme"],
    data: { id: "theme-presets", value: presets },
    noIndex: true,
    children: (
      <>
        <h1 id="page-title">Theme</h1>
        <p class="intro">Your own colors, spacing and type for this site.</p>
        <p id="status" class="status" role="status" aria-live="polite" />
        <section aria-labelledby="theme-presets-title">
          <h2 id="theme-presets-title">Ready-made themes</h2>
          <p class="hint">Click a CSS file to copy its contents.</p>
          <div id="theme-preset-list" class="theme-preset-list">
            {Object.keys(presets).map((name) => (
              <button type="button" data-preset={name}>
                {name}
              </button>
            ))}
          </div>
        </section>
        <form
          id="theme-form"
          class="stack"
          data-tokens={`${site.basePath}${ASSETS_PATH}/${tokens.file}`}
          novalidate
          hidden
        >
          <fieldset>
            <textarea
              id="theme-css"
              rows={24}
              aria-label="Theme (CSS)"
              aria-describedby="theme-hint"
              spellcheck={false}
            />
            <div class="editor-toolbar">
              <label class="checkbox-label">
                <input id="theme-preview" type="checkbox" /> Preview on this page
              </label>
              <span id="theme-state" class="hint" />
            </div>
            <p id="theme-hint" class="hint">
              Any CSS, within the site's rules: no @import, only fonts installed on the device, and
              images as data: URLs.
            </p>
            <div class="form-footer">
              <button id="theme-reset" type="button" class="destructive">
                Reset to the site's
              </button>
              <button id="theme-copy" type="button">
                Copy
              </button>
              <button type="submit" class="primary">
                Save
              </button>
            </div>
          </fieldset>
        </form>
      </>
    ),
  });
};
