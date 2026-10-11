// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import {
  defaultTextName,
  safeName,
  suggestedTextFileBase,
  textFileBase,
} from "../../../../public/k.mjs";
import {
  copyText,
  element,
  formatBytes,
  request,
  restoreForm,
  setBusy,
  storage,
} from "../../lib/common.js";
import { extensionOf } from "../../lib/items.js";
import { isMarkdown, renderMarkdown } from "../../lib/markdown.js";
import {
  createTextEditor,
  fillLanguages,
  MAX_HIGHLIGHT_CHARACTERS,
} from "../../lib/text-editor.js";
import { ASSETS, BUNDLE_MIME, readBundle, uniqueNames, writeBundle } from "../../shared/bundle.js";
import { h } from "../../shared/dom.js";
import { maxFilesAtOnce, textSizeText } from "../../shared/limits.js";

/*
 * The composer: text tabs and files, one Send. What it holds decides what a
 * send is: one text alone is a text item, files alone are an item each, and
 * anything else (texts with files, or several texts) one bundle, a tar the
 * pages show as its texts and files (see shared/bundle.js). An item's "edit"
 * opens it here: Send becomes Save changes, and saves it in place.
 */
export const createForms = ({ status, writeHeaders, refreshUnlessLive }) => {
  const sendForm = element("#send-form");
  const sendTitle = element("#send-title");
  const sendButton = element("#send-button");
  const cancelEdit = element("#cancel-edit");
  const addTab = element("#add-tab");
  const textInput = element("#text");
  const textLanguage = element("#text-language");
  const textPanel = element("#text-panel");
  const filesPanel = element("#files-panel");
  const textTabs = element("#text-tabs");
  const filesTab = element("#files-tab");
  const previewToggle = element("#preview-toggle");
  const markdownPreview = element("#markdown-preview");
  const summary = element("#send-summary");
  const fileInput = element("#file");
  const fileList = element("#file-list");
  const burnInput = element("#burn");
  const expiresInput = element("#expires-in");
  // The settings, folded into "[settings]" beside the Send heading: it says what
  // differs from the defaults, so a send never surprises.
  const settingsBox = element("#send-settings");
  const settingsState = element("#settings-state");
  const showSettings = () => {
    const changed = [
      burnInput.checked && "once",
      expiresInput.value && expiresInput.selectedOptions[0]?.textContent,
    ].filter(Boolean);
    settingsState.textContent = changed.join(" · ");
  };
  burnInput.addEventListener("change", showSettings);
  expiresInput.addEventListener("change", showSettings);
  // A page brought back from history may keep what was picked before.
  showSettings();
  // Open, it closes on Escape or a click elsewhere, as a menu does.
  document.addEventListener("click", (event) => {
    if (settingsBox.open && !settingsBox.contains(event.target)) settingsBox.open = false;
  });
  settingsBox.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !settingsBox.open) return;
    settingsBox.open = false;
    settingsBox.querySelector("summary").focus();
  });
  const sendSettings = () => ({
    burn: burnInput.checked,
    expiresIn: expiresInput.value || null,
  });
  const textLimit = element("#text-limit");
  const backupZip = element("#backup-zip");
  const backupTar = element("#backup-tar");
  const restore = element("#restore-form");
  const pageUrl = element("#page-url");
  const copyLinkButton = element("#copy-link");
  let mode = null;
  let config = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  /**
   * The item open here, or null: { entry, kind: "text" | "bundle" }, and for
   * a text what it held and was called, to save only what changed.
   */
  let editing = null;

  const languageKey = "kurobako-text-language";
  // Markdown until someone picks another language (Plain text is "").
  const savedLanguage = storage.get(languageKey) ?? "md";
  fillLanguages(textLanguage, savedLanguage);
  // The editor takes the textarea into itself: where it goes, from before that.
  const textInputParent = textInput.parentNode;
  const textInputNext = textInput.nextSibling;
  const mainTextEditor = createTextEditor(textInput, {
    title: () => (textLanguage.value ? `source.${textLanguage.value}` : ""),
  });
  textInputParent.insertBefore(mainTextEditor.editor, textInputNext);
  // The caret's line and column, with the language, below the text.
  textLanguage.parentElement.append(mainTextEditor.position);

  /** Encrypted files grow a little; the server's limit applies to what it receives. */
  const fileLimit = () => mode.fileLimit(config.maxFileBytes);

  // --- Tabs ----------------------------------------------------------------

  /** A text tab: its name (without extension), language, text, and whether its name follows the text. */
  const newTab = (base = "text", language = textLanguage.value) => ({
    base,
    language,
    text: "",
    automatic: true,
  });
  let tabs = [newTab()];
  /** The text tab shown, or "files". */
  let active = 0;
  let previewing = false;

  const fileNameOf = (tab) => safeName(`${tab.base}.${tab.language || "txt"}`, "text");
  const current = () => (active === "files" ? null : tabs[active]);

  /** The shown tab, back from the fields. */
  const saveTab = () => {
    const tab = current();
    if (!tab) return;
    tab.language = textLanguage.value;
    tab.text = textInput.value;
  };

  /**
   * A name typed for a tab: a known extension picks its language
   * (notes.md: Markdown); the rest is the name, made safe.
   */
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

  /** Turns tab `index`'s label into a field for its name: Enter keeps it, Escape does not. */
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
    saveTab();
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
        // A click on the tab already shown renames it, as does a double-click.
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
    const count = fileInput.files.length;
    filesTab.textContent = count ? `files (${count})` : "files";
  };

  /** Markdown, shown as it will read, with the picked files' images in place. */
  let previewUrls = [];
  const showPreview = () => {
    for (const url of previewUrls) URL.revokeObjectURL(url);
    previewUrls = [];
    const files = new Map([...fileInput.files].map((file) => [file.name, file]));
    markdownPreview.replaceChildren(
      renderMarkdown(textInput.value, {
        resolve: (path) => {
          // As the bundle will hold them, under assets/; a bare name finds them too.
          const file = files.get(path.startsWith(ASSETS) ? path.slice(ASSETS.length) : path);
          if (!file) return null;
          const url = URL.createObjectURL(file);
          previewUrls.push(url);
          return { url, type: file.type, name: file.name };
        },
      }),
    );
  };
  const setPreview = (on) => {
    previewing = on && isMarkdown(fileNameOf(current() ?? tabs[0]));
    previewToggle.setAttribute("aria-pressed", String(previewing));
    mainTextEditor.editor.hidden = previewing;
    markdownPreview.hidden = !previewing;
    if (previewing) showPreview();
  };
  previewToggle.addEventListener("click", () => setPreview(!previewing));

  const showLanguage = () => {
    previewToggle.hidden = !isMarkdown(`x.${textLanguage.value}`);
    if (previewToggle.hidden) setPreview(false);
  };

  /** Shows tab `index` (a text tab's, or "files"). */
  const select = (index) => {
    saveTab();
    active = index;
    const tab = current();
    textPanel.hidden = !tab;
    filesPanel.hidden = Boolean(tab);
    if (tab) {
      // An item's own extension, which the picker may not list yet.
      if (![...textLanguage.options].some((option) => option.value === tab.language)) {
        textLanguage.append(h("option", { value: tab.language }, `.${tab.language}`));
      }
      textLanguage.value = tab.language;
      textInput.value = tab.text;
      showLanguage();
      setPreview(false);
      mainTextEditor.refresh({ immediate: true });
      showTextSize();
    }
    showTabs();
    showSummary();
  };
  addTab.addEventListener("click", () => {
    saveTab();
    const taken = new Set(tabs.map((tab) => tab.base));
    let count = tabs.length + 1;
    while (taken.has(`text-${count}`)) count += 1;
    tabs.push(newTab(`text-${count}`, current()?.language ?? textLanguage.value));
    select(tabs.length - 1);
    textInput.focus();
  });
  filesTab.addEventListener("click", () => select("files"));
  // --- The text tab's fields --------------------------------------------------

  let nameTimer = null;
  /** A Markdown text's words, without its images and link targets. */
  const wordsOf = (text) =>
    isMarkdown(`x.${textLanguage.value}`)
      ? text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      : text;
  const suggestName = () => {
    const tab = current();
    if (tab?.automatic && tabs.length === 1) {
      const base = suggestedTextFileBase(wordsOf(textInput.value));
      if (base === tab.base) return;
      tab.base = base;
      showTabs();
    }
  };
  const applyLanguage = () => {
    storage.set(languageKey, textLanguage.value);
    saveTab();
    showLanguage();
    showTabs();
    mainTextEditor.refresh({ immediate: true });
  };
  textInput.addEventListener("input", () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(suggestName, 200);
  });
  textLanguage.addEventListener("change", applyLanguage);
  showLanguage();
  // The page comes with a Markdown tab: another saved language renames it.
  if (tabs[0].language !== "md") showTabs();
  suggestName();

  // --- Files -----------------------------------------------------------------

  /** The local date and time, 20261011-062124: names sort as pasted. */
  const pasteStamp = () => {
    const now = new Date();
    const two = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  };
  /** A pasted screenshot is "image.png" in every browser: give it its own name. */
  const named = (file) => {
    if (file.name && !/^image\.[a-z0-9]+$/i.test(file.name)) return file;
    const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "bin";
    return new File([file], `paste-${pasteStamp()}.${extension}`, { type: file.type });
  };
  /**
   * Files pasted or dropped on the text join the selection, as if picked
   * there; in a Markdown text, each also leaves its reference at the caret.
   */
  const takeFiles = (files) => {
    const picked = new DataTransfer();
    for (const file of fileInput.files) picked.items.add(file);
    for (const file of files.map(named)) picked.items.add(file);
    fileInput.files = picked.files;
    fileInput.dispatchEvent(new Event("change"));
    // As listed once named for the bundle (see normalizeFiles).
    const added = [...fileInput.files].slice(-files.length);
    if (isMarkdown(fileNameOf(current() ?? tabs[0]))) {
      const references = added
        .map((file) =>
          file.type.startsWith("image/")
            ? `![](${ASSETS}${file.name})`
            : `[${file.name}](${ASSETS}${file.name})`,
        )
        .join("\n");
      textInput.setRangeText(references, textInput.selectionStart, textInput.selectionEnd, "end");
      textInput.dispatchEvent(new Event("input"));
      status.success(
        `${added.length === 1 ? added[0].name : `${added.length} files`} added to files, and referenced in the text.`,
      );
      return;
    }
    status.success(
      added.length === 1
        ? `${added[0].name} added to files.`
        : `${added.length} files added to files.`,
    );
  };

  /**
   * A picked file's name, as a text refers to it once in a bundle
   * (assets/photo.png): a click copies that path, whole even where the name
   * shows cut short, as on a phone.
   */
  const copyPathButton = (file) => {
    const path = `${ASSETS}${file.name}`;
    const control = h(
      "button",
      { type: "button", class: "file-name", title: "Copy its path" },
      h("span", { class: "file-folder" }, ASSETS),
      file.name,
    );
    control.addEventListener("click", async () => {
      try {
        await copyText(path);
        status.success(`Copied ${path}.`);
      } catch (error) {
        status.error(error.message);
      }
    });
    return control;
  };

  // The files picked, pasted or dropped, one per line with their sizes and
  // the total: the browser's own field only says how many.
  /**
   * A picked file's name as a send keeps it: safe, and without spaces, so a
   * Markdown text refers to it as it is ("My Banner (1).JPG": My-Banner-1.JPG).
   */
  const sendName = (name) => {
    const safe = safeName(name, "file");
    const dot = safe.lastIndexOf(".");
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : "";
    const tidy = base
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
    return `${tidy || "file"}${extension}`;
  };
  /**
   * Gives the picked files the names a send keeps (see sendName, and unique),
   * so a text refers to them by the names listed here.
   */
  const normalizeFiles = () => {
    const files = [...fileInput.files];
    const names = uniqueNames(files.map((file) => sendName(file.name)));
    if (names.every((name, index) => name === files[index].name)) return;
    const renamed = new DataTransfer();
    for (const [index, file] of files.entries()) {
      renamed.items.add(
        names[index] === file.name ? file : new File([file], names[index], { type: file.type }),
      );
    }
    fileInput.files = renamed.files;
  };
  const showFiles = () => {
    normalizeFiles();
    const files = [...fileInput.files];
    if (previewing) showPreview();
    fileList.hidden = files.length === 0;
    showTabs();
    showSummary();
    if (!files.length) {
      fileList.replaceChildren();
      return;
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    /** A small action in a row of the list. */
    const action = (label, name, onClick) => {
      const button = h(
        "button",
        { type: "button", class: "row-action", "aria-label": name },
        label,
      );
      button.addEventListener("click", onClick);
      return button;
    };
    fileList.replaceChildren(
      ...files.map((file, index) =>
        h(
          "li",
          { class: file.size > fileLimit() ? "too-large" : undefined },
          copyPathButton(file),
          h(
            "span",
            { class: "file-size" },
            formatBytes(file.size),
            file.size > fileLimit() ? " · too large" : "",
            action("remove", `Remove ${file.name}`, () => removeFile(index)),
          ),
        ),
      ),
      h(
        "li",
        { class: "file-total" },
        h("span", {}, `Total · ${files.length === 1 ? "1 file" : `${files.length} files`}`),
        h(
          "span",
          { class: "file-size" },
          formatBytes(total),
          action("clear", "Remove every file", () => clearFiles()),
        ),
      ),
    );
  };
  /** Takes one file back out of the send. */
  const removeFile = (index) => {
    const kept = new DataTransfer();
    for (const [other, file] of [...fileInput.files].entries()) {
      if (other !== index) kept.items.add(file);
    }
    fileInput.files = kept.files;
    showFiles();
    // Focus stays in the list, on the next file's button or the clear.
    fileList.querySelectorAll(".row-action")[Math.min(index, fileInput.files.length)]?.focus();
  };
  fileInput.addEventListener("change", showFiles);
  const clearFiles = () => {
    fileInput.value = "";
    showFiles();
  };

  // Files pasted or dropped on the text join the files, as if picked there: a
  // screenshot is sent as an image, not as text. A paste that also carries
  // text (a spreadsheet's cells, say) stays text.
  textInput.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length || event.clipboardData.getData("text/plain").trim()) return;
    event.preventDefault();
    takeFiles(files);
  });
  mainTextEditor.editor.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    takeFiles(files);
  });

  // --- What a send is ----------------------------------------------------------

  /** The texts to send: the tabs with something in them. */
  const filledTabs = () => tabs.filter((tab) => tab.text.trim());
  /** "text" | "files" | "bundle" | null, by what the composer holds. */
  const sendKind = () => {
    const texts = filledTabs().length;
    const files = fileInput.files.length;
    if (!texts && !files) return null;
    if (texts === 1 && !files) return "text";
    if (!texts) return "files";
    return "bundle";
  };
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  let summaryTimer = null;
  const showSummary = () => {
    clearTimeout(summaryTimer);
    summaryTimer = null;
    const texts = filledTabs();
    const files = fileInput.files.length;
    const kind = sendKind();
    summary.textContent = editing
      ? `Editing ${editing.entry.info.title}.`
      : kind === "bundle"
        ? `Bundle: ${[texts.length && plural(texts.length, "text"), files && plural(files, "file")].filter(Boolean).join(", ")}.`
        : kind === "files" && files > 1
          ? `${plural(files, "file")}, one item each.`
          : "";
  };

  /** The same contents already in the queue move to the top instead (200, not 201). */
  const sentMessage = async (response) =>
    response.status === 200 && (await response.json()).existing
      ? "Already in the queue: moved to the top."
      : "Sent.";

  /**
   * The most files one send takes, by the server's own limits: no more than
   * the queue holds (more would push out what was just sent) nor than it takes
   * in a minute, since each file is a send. 20 if the server says neither.
   */
  const maxFiles = () => maxFilesAtOnce(config);

  /** Waits `seconds`, calling `tick(secondsLeft)` once a second. */
  const countdown = async (seconds, tick) => {
    for (let left = seconds; left > 0; left -= 1) {
      tick(left);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };

  /** Back to one empty text tab and no files, after a send or an edit. */
  const clearComposer = () => {
    editing = null;
    showEditing();
    tabs = [newTab("text", textLanguage.value)];
    active = null;
    clearFiles();
    select(0);
    suggestName();
  };

  const sendText = async (tab) => {
    if (encoder.encode(tab.text).byteLength > config.maxTextBytes) {
      throw new Error(`Text too large. Max ${formatBytes(config.maxTextBytes)}.`);
    }
    status.progress("Sending…");
    const response = await mode.sendText(tab.text, { ...sendSettings(), name: fileNameOf(tab) });
    return sentMessage(response);
  };

  const sendFiles = async (files) => {
    if (files.length > maxFiles()) throw new Error(`Too many files: up to ${maxFiles()} at once.`);
    const tooLarge = files.filter((file) => file.size > fileLimit());
    if (tooLarge.length) {
      throw new Error(
        `Too large (max ${formatBytes(fileLimit())}): ${tooLarge.map((file) => file.name).join(", ")}.`,
      );
    }
    // The last picked goes first, so the queue, newest on top, lists them as
    // they were picked.
    const queue = files.toReversed();
    let sent = 0;
    let moved = 0;
    try {
      let waits = 0;
      for (let index = 0; index < queue.length; ) {
        status.progress(files.length > 1 ? `Sending ${sent + 1} of ${files.length}…` : "Sending…");
        let response;
        try {
          response = await mode.sendFile(queue[index], sendSettings());
        } catch (error) {
          // Past the sends allowed a minute: wait as the server asks, then go
          // on with the same file. Three waits in a row without a send: stop.
          if (error.status !== 429 || !error.retryAfter || waits >= 3) throw error;
          waits += 1;
          await countdown(error.retryAfter, (left) =>
            status.progress(
              `Send limit reached: going on in ${left} s${files.length > 1 ? ` · ${sent} of ${files.length} sent` : ""}`,
            ),
          );
          continue;
        }
        waits = 0;
        if (response.status === 200 && (await response.json()).existing) moved += 1;
        sent += 1;
        index += 1;
      }
    } catch (error) {
      // Keep only what was not sent, so sending again sends the rest.
      const rest = new DataTransfer();
      for (const file of queue.slice(sent).toReversed()) rest.items.add(file);
      fileInput.files = rest.files;
      fileInput.dispatchEvent(new Event("change"));
      throw new Error(
        sent ? `Sent ${sent} of ${files.length}, then: ${error.message}` : error.message,
      );
    }
    return files.length === 1
      ? moved
        ? "Already in the queue: moved to the top."
        : "Sent."
      : `Sent ${files.length} files${moved ? ` (${moved} already in the queue, moved to the top)` : ""}.`;
  };

  /**
   * A Markdown text's references to the attached files by their bare name
   * (![](photo.png)) made to point where the bundle keeps them
   * (assets/photo.png), so the text reads right in any Markdown viewer.
   */
  const withAssetPaths = (text, files) => {
    const names = new Set(files.map((file) => file.name));
    return text.replace(/(!?\[[^\]\n]*\]\(\s*)(<?)([^)\s>]+)/g, (whole, start, open, target) => {
      let name = target;
      try {
        name = decodeURIComponent(target.replace(/^\.\//, ""));
      } catch {
        return whole;
      }
      return names.has(name) ? `${start}${open}${ASSETS}${target.replace(/^\.\//, "")}` : whole;
    });
  };

  /**
   * Texts and files together, as one tar named after the first text: the
   * texts at its root, the files under assets/ (their names are already
   * unique, see normalizeFiles).
   */
  const bundleFile = async (texts, files) => {
    const names = uniqueNames(texts.map(fileNameOf));
    const entries = [
      ...texts.map((tab, index) => ({
        path: names[index],
        type: isMarkdown(names[index]) ? "text/markdown" : "text/plain",
        text: true,
        bytes: encoder.encode(
          isMarkdown(names[index]) ? withAssetPaths(tab.text, files) : tab.text,
        ),
      })),
      ...(await Promise.all(
        files.map(async (file) => ({
          path: `${ASSETS}${file.name}`,
          type: file.type || "application/octet-stream",
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      )),
    ];
    const bytes = writeBundle({ main: names[0], entries });
    if (bytes.length > fileLimit()) {
      throw new Error(
        `The bundle is too large: ${formatBytes(bytes.length)}, max ${formatBytes(fileLimit())}.`,
      );
    }
    const name = `${names[0].replace(/\.[^.]+$/, "")}.tar`;
    return new File([bytes], name, { type: BUNDLE_MIME });
  };
  const sendBundle = async (texts, files) => {
    const file = await bundleFile(texts, files);
    status.progress("Sending…");
    return sentMessage(await mode.sendFile(file, sendSettings()));
  };

  // --- Editing an item ---------------------------------------------------------

  /** Send, or Save changes: what the form says it does. */
  const showEditing = () => {
    sendTitle.textContent = editing ? "Edit" : "Send";
    sendButton.textContent = editing ? "Save changes" : "Send";
    cancelEdit.hidden = !editing;
    // Burn and expiry are a send's; an edit keeps the item's.
    settingsBox.hidden = Boolean(editing);
    // A text stays one text: no tabs or files to add.
    const single = editing?.kind === "text";
    addTab.hidden = single;
    filesTab.hidden = single;
  };

  /** A tab for a text called `title` (notes.md: Markdown). */
  const tabOf = (title, text) => {
    const extension = extensionOf(title);
    return {
      base: textFileBase(extension ? title.slice(0, -extension.length - 1) : title),
      language: extension === "txt" ? "" : extension,
      text,
      automatic: false,
    };
  };

  /** Opens an item's text, or a bundle's texts and files, here to be edited. */
  const edit = async (entry) => {
    saveTab();
    const holding = filledTabs().length > 0 || fileInput.files.length > 0;
    if (
      (editing || holding) &&
      !window.confirm("Open this item in the composer? What it holds now is dropped.")
    ) {
      return;
    }
    const { item, info } = entry;
    status.progress("Opening…");
    let opened;
    try {
      if (info.isBundle) {
        const bundle = readBundle(new Uint8Array(await (await mode.loadBlob(item)).arrayBuffer()));
        const texts = bundle.entries.filter((part) => part.text);
        // The main text is the first tab, as it was sent.
        texts.sort((a, b) => Number(b.path === bundle.main) - Number(a.path === bundle.main));
        const files = new DataTransfer();
        for (const part of bundle.entries.filter((part) => !part.text)) {
          const name = part.path.startsWith(ASSETS) ? part.path.slice(ASSETS.length) : part.path;
          files.items.add(new File([part.bytes], name, { type: part.type }));
        }
        opened = {
          editing: { entry, kind: "bundle" },
          tabs: texts.map((part) => tabOf(part.path, decoder.decode(part.bytes))),
          files: files.files,
        };
      } else {
        const text = await mode.loadText(item);
        const tab = tabOf(info.title, text);
        // A text named by its start keeps following it, as the server does.
        tab.automatic = info.title === defaultTextName(text);
        opened = {
          editing: { entry, kind: "text", original: text, name: fileNameOf(tab) },
          tabs: [tab],
          files: new DataTransfer().files,
        };
      }
    } catch (error) {
      status.error(error.message);
      return;
    }
    editing = opened.editing;
    tabs = opened.tabs.length ? opened.tabs : [newTab()];
    fileInput.files = opened.files;
    active = null;
    showEditing();
    showFiles();
    select(0);
    status.success(`Editing ${info.title}: Save changes when done.`);
    sendForm.scrollIntoView({ block: "start" });
    textInput.focus({ preventScroll: true });
  };
  cancelEdit.addEventListener("click", () => {
    clearComposer();
    status.success("Edit cancelled.");
  });

  /** Saves the item open here, at the version it was opened at. */
  const saveEdit = async (kind) => {
    const { item } = editing.entry;
    if (editing.kind === "text") {
      if (kind !== "text") throw new Error("Nothing to save: write a text.");
      const tab = filledTabs()[0];
      if (encoder.encode(tab.text).byteLength > config.maxTextBytes) {
        throw new Error(`Text too large. Max ${formatBytes(config.maxTextBytes)}.`);
      }
      const name = fileNameOf(tab);
      status.progress("Saving…");
      await mode.editText(item, tab.text, {
        original: editing.original,
        title: tab.automatic || name === editing.name ? null : name,
      });
      return "Saved.";
    }
    const texts = filledTabs();
    if (!texts.length) throw new Error("A bundle keeps at least one text.");
    const file = await bundleFile(texts, [...fileInput.files]);
    status.progress("Saving…");
    await mode.editFile(item, file);
    return "Saved.";
  };

  sendForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveTab();
    // A name still following the text takes its last words.
    clearTimeout(nameTimer);
    suggestName();
    const kind = sendKind();
    if (!kind) {
      status.error(
        editing ? "Nothing to save: write a text." : "Nothing to send: write a text or add files.",
      );
      return;
    }
    setBusy(sendForm, true);
    try {
      const files = [...fileInput.files];
      const message = editing
        ? await saveEdit(kind)
        : kind === "text"
          ? await sendText(filledTabs()[0])
          : kind === "files"
            ? await sendFiles(files)
            : await sendBundle(filledTabs(), files);
      clearComposer();
      status.success(message);
    } catch (error) {
      status.error(error.message);
    } finally {
      setBusy(sendForm, false);
      await refreshUnlessLive();
    }
  });

  // --- The rest of the page -------------------------------------------------------

  // The server names the file and sends it as a download: the page stays.
  backupZip.addEventListener("click", () => window.location.assign(`${mode.basePath}/zip`));
  backupTar.addEventListener("click", () => window.location.assign(`${mode.basePath}/tar`));

  restoreForm({
    form: restore,
    input: element("#restore-file"),
    status,
    send: async (file) =>
      (
        await request(`${mode.basePath}/import`, {
          method: "POST",
          headers: writeHeaders(),
          body: file,
        })
      ).json(),
    // The live connection brings the new queue; this is for when it is down.
    done: refreshUnlessLive,
  });

  const copyLink = async () => {
    pageUrl.select();
    try {
      await copyText(mode.shareUrl);
      status.success("Link copied.");
    } catch (error) {
      status.error(error.message);
    }
  };
  pageUrl.addEventListener("click", copyLink);
  copyLinkButton.addEventListener("click", copyLink);

  // The limits, expiry and hints come written by the server (namespace.tsx);
  // only the address, which an encrypted page holds in its fragment, is ours.
  const showPage = () => {
    pageUrl.value = mode.shareUrl;
    // A reload, or a page brought back from history, may keep the files
    // picked before without saying so: list them (with the mode, which
    // tells their limit).
    showFiles();
  };
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && mode) showFiles();
  });

  /** Under the text: its size against the limit, red past it. */
  let textSizeTimer = null;
  const showTextSize = () => {
    clearTimeout(textSizeTimer);
    textSizeTimer = null;
    if (!config) return;
    const text = textInput.value;
    const bytes = encoder.encode(text).byteLength;
    const paused = text.length > MAX_HIGHLIGHT_CHARACTERS;
    textLimit.textContent = textSizeText(bytes, config.maxTextBytes, paused);
    textLimit.title = `${formatBytes(bytes)} of ${formatBytes(config.maxTextBytes)}${paused ? "; too long to color" : ""}`;
    textLimit.classList.toggle("over", bytes > config.maxTextBytes);
  };
  // Counting and UTF-8 encoding a long text on every key would lag typing.
  textInput.addEventListener("input", () => {
    saveTab();
    clearTimeout(textSizeTimer);
    textSizeTimer = setTimeout(showTextSize, 300);
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(showSummary, 300);
  });

  return {
    setMode(value) {
      mode = value;
    },
    setConfig(value) {
      config = value;
    },
    showPage,
    edit,
  };
};
