// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Preview is off on opening, so a theme that hides the page can always be mended here.
import { copyText, element, storage } from "../lib/common.js";
import { confirmAction } from "../lib/dialog.js";
import { loadHighlighter } from "../lib/highlight.js";
import { createStatus } from "../lib/status.js";
import { createTextEditor } from "../lib/text-editor.js";

/** head/parts/custom-theme.js reads the same. */
const THEME_KEY = "kurobako-custom-theme";

const status = createStatus(element("#status"));
const form = element("#theme-form");
const textarea = element("#theme-css");
const previewToggle = element("#theme-preview");
const state = element("#theme-state");
const presets = JSON.parse(element("#theme-presets").textContent);

element("#theme-preset-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-preset]");
  if (!button) return;
  try {
    await copyText(presets[button.dataset.preset]);
    status.success(`${button.dataset.preset} copied.`);
  } catch (error) {
    status.error(error.message);
  }
});

// The editor takes the textarea in, so its place is found first.
const parent = textarea.parentNode;
const next = textarea.nextSibling;
const editor = createTextEditor(textarea, { title: () => "theme.css" });
parent.insertBefore(editor.editor, next);

let defaults = "";
/** Built by script, as the CSP allows. */
const sheet = "adoptedStyleSheets" in document ? new CSSStyleSheet() : null;
const preview = () => {
  if (!sheet) return;
  try {
    sheet.replaceSync(previewToggle.checked ? textarea.value : "");
  } catch {
    // As a browser skips unreadable CSS.
  }
  if (!document.adoptedStyleSheets.includes(sheet)) {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
};
const showState = () => {
  const saved = storage.get(THEME_KEY);
  state.textContent =
    saved === null
      ? textarea.value === defaults
        ? "The site's theme."
        : "Not saved."
      : textarea.value === saved
        ? "Saved."
        : "Not saved.";
};
const show = (css) => {
  textarea.value = css;
  editor.refresh({ immediate: true });
  preview();
  showState();
};

let timer = null;
textarea.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    preview();
    showState();
  }, 150);
});
previewToggle.addEventListener("change", preview);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const css = textarea.value;
  // Not kept, so the site's later changes apply.
  if (css.trim() === defaults.trim()) storage.remove(THEME_KEY);
  else storage.set(THEME_KEY, css);
  if (css.trim() !== defaults.trim() && storage.get(THEME_KEY) !== css) {
    status.error("This browser keeps nothing for this site (a private window?): not saved.");
    return;
  }
  showState();
  status.success("Saved: every page uses it now.");
});

element("#theme-reset").addEventListener("click", async () => {
  const reset = await confirmAction({
    title: "Back to the site's theme?",
    message: "Your theme is forgotten on this device. Copy it first to keep it.",
    confirm: "Reset",
    destructive: true,
  });
  if (!reset) return;
  storage.remove(THEME_KEY);
  show(defaults);
  status.success("The site's theme again.");
});

element("#theme-copy").addEventListener("click", async () => {
  try {
    await copyText(textarea.value);
    status.success("Theme copied.");
  } catch (error) {
    status.error(error.message);
  }
});

try {
  const response = await fetch(form.dataset.tokens);
  if (!response.ok) throw new Error(`The site's tokens did not load (${response.status}).`);
  defaults = await response.text();
  const saved = storage.get(THEME_KEY);
  previewToggle.checked = saved === null;
  show(saved ?? defaults);
  form.hidden = false;
  if (!sheet) status.error("This browser cannot use themes: it is too old for them.");
  (window.requestIdleCallback ?? setTimeout)(() => void loadHighlighter().catch(() => {}));
} catch (error) {
  status.error(error.message);
}
