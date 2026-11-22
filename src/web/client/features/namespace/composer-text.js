// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The composer's texts: tabs with names and languages, the editor, the
// Markdown preview and the size under it. The files tab is listed here too.
import { safeName, suggestedTextFileBase, textFileBase } from "../../../../sdk/k.mjs";
import { element, formatBytes, storage } from "../../lib/common.js";
import { extensionOf } from "../../lib/items.js";
import { isMarkdown } from "../../lib/markdown.js";
import {
  createTextEditor,
  fillLanguages,
  MAX_HIGHLIGHT_CHARACTERS,
} from "../../lib/text-editor.js";
import { h } from "../../shared/dom.js";
import { textSizeText } from "../../shared/limits.js";
import { createComposerPreview } from "./preview.js";

const LANGUAGE_KEY = "kurobako-text-language";
const encoder = new TextEncoder();

/**
 * `files` and `fileCount` read the composer's files (the preview shows them,
 * the files tab counts them); `onFiles` takes files pasted or dropped on the
 * text; `onChange` runs when the texts or the shown tab change.
 */
export const createTextComposer = ({ config, files, fileCount, onFiles, onChange }) => {
  const addTab = element("#add-tab");
  const textInput = element("#text");
  const textLanguage = element("#text-language");
  const textPanel = element("#text-panel");
  const filesPanel = element("#files-panel");
  const textTabs = element("#text-tabs");
  const filesTab = element("#files-tab");
  const previewToggle = element("#preview-toggle");
  const markdownPreview = element("#markdown-preview");
  const textLimit = element("#text-limit");

  fillLanguages(textLanguage, storage.get(LANGUAGE_KEY) ?? "md");
  // The editor takes the textarea in, so its place is found first.
  const textInputParent = textInput.parentNode;
  const textInputNext = textInput.nextSibling;
  const editor = createTextEditor(textInput, {
    title: () => (textLanguage.value ? `source.${textLanguage.value}` : ""),
  });
  textInputParent.insertBefore(editor.editor, textInputNext);
  textLanguage.parentElement.append(editor.position);

  const newTab = (base = "text", language = textLanguage.value) => ({
    base,
    language,
    text: "",
    automatic: true,
  });
  let tabs = [newTab()];
  /** A tab's index, or "files". */
  let active = 0;
  let previewing = false;

  const fileNameOf = (tab) => safeName(`${tab.base}.${tab.language || "txt"}`, "text");
  const current = () => (active === "files" ? null : tabs[active]);
  const markdownShown = () => isMarkdown(fileNameOf(current() ?? tabs[0]));

  const save = () => {
    const tab = current();
    if (!tab) return;
    tab.language = textLanguage.value;
    tab.text = textInput.value;
  };

  /** A known extension picks the language (notes.md: Markdown). */
  const rename = (tab, typed) => {
    let name = typed.trim();
    const match = /\.([A-Za-z0-9_+-]+)$/.exec(name);
    if (match) {
      const extension = match[1].toLowerCase();
      const language = extension === "txt" ? "" : extension;
      if ([...textLanguage.options].some((option) => option.value === language)) {
        name = name.slice(0, -match[0].length);
        tab.language = language;
      }
    }
    tab.base = textFileBase(name);
    tab.automatic = false;
  };

  /** An item's title as a tab: its extension is the language. */
  const tabOf = (title, text) => {
    const extension = extensionOf(title);
    return {
      base: textFileBase(extension ? title.slice(0, -extension.length - 1) : title),
      language: extension === "txt" ? "" : extension,
      text,
      automatic: false,
    };
  };

  const startRename = (index, button) => {
    const tab = tabs[index];
    const input = h("input", {
      type: "text",
      class: "tab-rename",
      value: fileNameOf(tab),
      "aria-label": "Tab name",
      maxlength: 100,
      spellcheck: "false",
      autocomplete: "off",
    });
    input.size = Math.max(8, input.value.length);
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      if (keep && input.value.trim()) {
        rename(tab, input.value);
        if (index === active) {
          textLanguage.value = tab.language;
          applyLanguage();
        }
      }
      showTabs();
      textTabs.querySelector(`[data-tab="${index}"]`)?.focus();
    };
    input.addEventListener("input", () => {
      input.size = Math.max(8, input.value.length);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    button.replaceWith(input);
    input.focus();
    input.setSelectionRange(0, tab.base.length);
  };

  const closeTab = (index) => {
    if (tabs.length < 2) return;
    save();
    tabs.splice(index, 1);
    const next =
      active === "files"
        ? "files"
        : Math.min(active > index ? active - 1 : active, tabs.length - 1);
    active = null;
    select(next);
  };

  const showTabs = () => {
    textTabs.replaceChildren(
      ...tabs.map((tab, index) => {
        const name = fileNameOf(tab);
        const button = h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": String(index === active),
            "aria-controls": "text-panel",
            "data-tab": index,
            title: "Click again, double-click or press F2 to rename",
            tabindex: index === active || (active === "files" && index === 0) ? "0" : "-1",
          },
          name,
        );
        button.addEventListener("click", () =>
          index === active ? startRename(index, button) : select(index),
        );
        button.addEventListener("dblclick", () => startRename(index, button));
        button.addEventListener("keydown", (event) => {
          if (event.key === "F2") startRename(index, button);
        });
        if (tabs.length < 2) return button;
        const close = h(
          "button",
          { type: "button", class: "tab-close", "aria-label": `Close ${name}`, title: "Close" },
          "×",
        );
        close.addEventListener("click", () => closeTab(index));
        return h("span", { class: "text-tab" }, button, close);
      }),
    );
    filesTab.setAttribute("aria-selected", String(active === "files"));
    filesTab.tabIndex = active === "files" ? 0 : -1;
    const count = fileCount();
    filesTab.textContent = count ? `files (${count})` : "files";
  };

  const preview = createComposerPreview({
    target: markdownPreview,
    source: () => textInput.value,
    files,
    isVisible: () => previewing,
  });
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) preview.dispose();
  });
  const setPreview = (on) => {
    previewing = on && markdownShown();
    previewToggle.setAttribute("aria-pressed", String(previewing));
    editor.editor.hidden = previewing;
    markdownPreview.hidden = !previewing;
    if (previewing) preview.render();
  };
  previewToggle.addEventListener("click", () => setPreview(!previewing));

  const showLanguage = () => {
    previewToggle.hidden = !isMarkdown(`x.${textLanguage.value}`);
    if (previewToggle.hidden) setPreview(false);
  };

  let textSizeTimer = null;
  const showTextSize = () => {
    clearTimeout(textSizeTimer);
    textSizeTimer = null;
    const limits = config();
    if (!limits) return;
    const text = textInput.value;
    const bytes = encoder.encode(text).byteLength;
    const paused = text.length > MAX_HIGHLIGHT_CHARACTERS;
    textLimit.textContent = textSizeText(bytes, limits.maxTextBytes, paused);
    textLimit.title = `${formatBytes(bytes)} of ${formatBytes(limits.maxTextBytes)}${paused ? "; too long to color" : ""}`;
    textLimit.classList.toggle("over", bytes > limits.maxTextBytes);
  };

  /** A tab's index, or "files". */
  const select = (index) => {
    save();
    active = index;
    const tab = current();
    textPanel.hidden = !tab;
    filesPanel.hidden = Boolean(tab);
    if (tab) {
      // The picker may not list it yet.
      if (![...textLanguage.options].some((option) => option.value === tab.language)) {
        textLanguage.append(h("option", { value: tab.language }, `.${tab.language}`));
      }
      textLanguage.value = tab.language;
      textInput.value = tab.text;
      showLanguage();
      setPreview(false);
      editor.refresh({ immediate: true });
      showTextSize();
    }
    showTabs();
    onChange();
  };
  addTab.addEventListener("click", () => {
    save();
    const taken = new Set(tabs.map((tab) => tab.base));
    let count = tabs.length + 1;
    while (taken.has(`text-${count}`)) count += 1;
    tabs.push(newTab(`text-${count}`, current()?.language ?? textLanguage.value));
    select(tabs.length - 1);
    textInput.focus();
  });
  filesTab.addEventListener("click", () => select("files"));

  let nameTimer = null;
  const wordsOf = (text) =>
    isMarkdown(`x.${textLanguage.value}`)
      ? text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      : text;
  /** A lone text not named by hand is named by its start. */
  const suggestName = () => {
    clearTimeout(nameTimer);
    const tab = current();
    if (tab?.automatic && tabs.length === 1) {
      const base = suggestedTextFileBase(wordsOf(textInput.value));
      if (base === tab.base) return;
      tab.base = base;
      showTabs();
    }
  };
  const applyLanguage = () => {
    storage.set(LANGUAGE_KEY, textLanguage.value);
    save();
    showLanguage();
    showTabs();
    editor.refresh({ immediate: true });
  };
  textLanguage.addEventListener("change", applyLanguage);

  // Counting and encoding a long text on every key would lag typing.
  let changeTimer = null;
  textInput.addEventListener("input", () => {
    save();
    clearTimeout(nameTimer);
    nameTimer = setTimeout(suggestName, 200);
    clearTimeout(textSizeTimer);
    textSizeTimer = setTimeout(showTextSize, 300);
    clearTimeout(changeTimer);
    changeTimer = setTimeout(onChange, 300);
  });

  // So a screenshot is sent as an image, not text. A paste that also carries
  // text (a spreadsheet's cells) stays text.
  textInput.addEventListener("paste", (event) => {
    const pasted = [...(event.clipboardData?.files ?? [])];
    if (!pasted.length || event.clipboardData.getData("text/plain").trim()) return;
    event.preventDefault();
    onFiles(pasted);
  });
  editor.editor.addEventListener("drop", (event) => {
    const dropped = [...(event.dataTransfer?.files ?? [])];
    if (!dropped.length) return;
    event.preventDefault();
    onFiles(dropped);
  });

  showLanguage();
  if (tabs[0].language !== "md") showTabs();
  suggestName();

  return {
    fileNameOf,
    tabOf,
    newTab,
    rename,
    save,
    select,
    showTabs,
    suggestName,
    markdownShown,
    /** Texts with something in them. */
    filled: () => tabs.filter((tab) => tab.text.trim()),
    /** Replaced, then shown from `index` (a tab or "files"). */
    replace(next, index = 0) {
      tabs = next.length ? next : [newTab()];
      active = null;
      select(index);
    },
    /** Back to one empty text in the language last used. */
    clear() {
      tabs = [newTab("text", textLanguage.value)];
      active = null;
      select(0);
      suggestName();
    },
    refreshPreview() {
      if (previewing) preview.render();
    },
    /** At the caret, as typed. */
    insert(text) {
      textInput.setRangeText(text, textInput.selectionStart, textInput.selectionEnd, "end");
      textInput.dispatchEvent(new Event("input"));
    },
    focus: (options) => textInput.focus(options),
    /** An edited text is one item: no other tabs, no files. */
    setSingle(single) {
      addTab.hidden = single;
      filesTab.hidden = single;
    },
  };
};
