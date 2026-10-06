// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Syntax-highlighted native textareas and their language picker. The editable
// textarea stays in charge of selection, forms and accessibility; a copy below
// it only paints the syntax colors.
import { el } from "./common.js";
import { icon } from "./icons.js";
import {
  DETECTION_CHARACTERS,
  extensionOf,
  highlightedCode,
  MAX_HIGHLIGHT_CHARACTERS,
} from "./items.js";
import hljs from "./vendor/highlight.js";

const PREFERRED_EXTENSIONS = {
  bash: "sh",
  csharp: "cs",
  javascript: "js",
  kotlin: "kt",
  markdown: "md",
  objectivec: "m",
  perl: "pl",
  plaintext: "txt",
  python: "py",
  ruby: "rb",
  rust: "rs",
  typescript: "ts",
  vbnet: "vb",
  xml: "html",
  yaml: "yml",
};

export { MAX_HIGHLIGHT_CHARACTERS };

export const languageOptions = (selected, { plain = false } = {}) => {
  const options = plain
    ? [
        el("option", { value: "", textContent: "Plain text" }),
        el("option", { value: "auto", textContent: "Auto detect" }),
      ]
    : [el("option", { value: "", textContent: "Auto · no extension" })];
  for (const language of hljs.listLanguages()) {
    const details = hljs.getLanguage(language);
    const extension = PREFERRED_EXTENSIONS[language] ?? language;
    options.push(
      el("option", {
        value: extension,
        textContent: `${details?.name ?? language} · .${extension}`,
      }),
    );
  }
  if (selected && selected !== "auto" && !options.some((option) => option.value === selected)) {
    const details = hljs.getLanguage(selected);
    options.splice(
      1,
      0,
      el("option", {
        value: selected,
        textContent: `${details?.name ?? selected} · .${selected}`,
      }),
    );
  }
  return options;
};

export const withExtension = (title, extension) => {
  const base = title.replace(/\.[A-Za-z0-9_+-]+$/, "");
  return extension ? `${base}.${extension}` : base;
};

/**
 * Keeps a native textarea editable over a syntax-colored, scroll-synchronized
 * copy. The textarea's own letters are transparent, so the copy must follow
 * every keystroke: it is redrawn on the next frame with one grammar, which is
 * quick. Guessing a language means running every grammar, so that happens
 * once, then again only when typing pauses. A text too large to color on
 * every keystroke shows its letters at once and its colors when typing pauses.
 */
export const createTextEditor = (
  textarea,
  { title = () => "", autoDetect = () => true, fullscreenRoot, onError = () => {} } = {},
) => {
  const highlight = el("pre", { className: "text-editor-highlight", ariaHidden: true });
  /** Line numbers, shown in full screen only, where lines do not wrap. */
  const gutter = el("div", { className: "text-editor-gutter", ariaHidden: true });
  let numbered = 0;
  /** The language guessed for a text whose name has no extension; null until guessed. */
  let detected = null;
  let detectTimer = null;
  let colorTimer = null;
  let frame = null;
  /** Whether coloring the whole text took too long to do on every keystroke. */
  let slow = false;

  const guessing = () => !extensionOf(title()) && autoDetect();
  /** A name whose extension picks the grammar, or null to leave the text plain. */
  const sourceName = () => {
    const name = title();
    if (extensionOf(name)) return name;
    return guessing() && detected ? `source.${detected}` : null;
  };

  const paint = (colored) => {
    const text = textarea.value;
    const source = sourceName();
    let code;
    if (colored && source && text.length <= MAX_HIGHLIGHT_CHARACTERS) {
      const started = performance.now();
      code = highlightedCode(text, source);
      slow = performance.now() - started > 12;
    } else {
      code = el("code", { className: "hljs", textContent: text });
    }
    // A visible character after a final newline keeps both layers' scroll
    // heights equal at the bottom of the document.
    if (text.endsWith("\n")) code.append(" ");
    highlight.replaceChildren(code);
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
    numberLines();
  };

  /** Numbers the lines, in full screen: redrawn only when their count changes. */
  const numberLines = () => {
    if (document.fullscreenElement !== root) return;
    let lines = 1;
    for (
      let at = textarea.value.indexOf("\n");
      at !== -1;
      at = textarea.value.indexOf("\n", at + 1)
    ) {
      lines += 1;
    }
    if (lines !== numbered) {
      numbered = lines;
      gutter.textContent = `${Array.from({ length: lines }, (_, index) => index + 1).join("\n")}\n`;
      editor.style.setProperty("--gutter-digits", String(String(lines).length));
    }
    gutter.scrollTop = textarea.scrollTop;
  };

  /** Guesses the language from a bounded sample, then colors with it. */
  const detect = () => {
    detectTimer = null;
    if (!guessing()) return;
    const sample = textarea.value.slice(0, DETECTION_CHARACTERS);
    detected = sample.trim() ? (hljs.highlightAuto(sample).language ?? null) : null;
    paint(true);
  };

  const refresh = ({ immediate = false } = {}) => {
    clearTimeout(colorTimer);
    if (immediate) {
      if (guessing() && detected === null) detect();
      else paint(true);
      return;
    }
    if (frame === null) {
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!slow) {
          paint(true);
          return;
        }
        paint(false);
        colorTimer = setTimeout(() => paint(true), 400);
      });
    }
    if (guessing()) {
      clearTimeout(detectTimer);
      detectTimer = setTimeout(detect, detected ? 2_000 : 600);
    }
  };

  const expand = el(
    "button",
    {
      type: "button",
      className: "icon-button text-editor-expand",
      ariaLabel: "Edit in full screen",
      title: "Edit in full screen",
    },
    icon("expand"),
  );
  /** Where the caret is: "Ln 12, Col 5", and how much is selected. */
  const position = el("span", { className: "text-editor-position", ariaHidden: true });
  let positionFrame = null;
  const showPosition = () => {
    positionFrame = null;
    const { value, selectionStart: start, selectionEnd: end } = textarea;
    const caret = textarea.selectionDirection === "backward" ? start : end;
    let line = 1;
    for (let at = value.indexOf("\n"); at !== -1 && at < caret; at = value.indexOf("\n", at + 1)) {
      line += 1;
    }
    const column = caret - value.lastIndexOf("\n", caret - 1);
    const selected = end - start;
    position.textContent = `Ln ${line}, Col ${column}${selected ? ` · ${selected} selected` : ""}`;
  };
  const updatePosition = () => {
    if (positionFrame === null) positionFrame = requestAnimationFrame(showPosition);
  };

  const editor = el(
    "div",
    { className: "text-editor" },
    gutter,
    highlight,
    textarea,
    expand,
    position,
  );
  const root = fullscreenRoot ?? editor;
  root.classList.add("text-editor-fullscreen");

  expand.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else await root.requestFullscreen();
      textarea.focus();
    } catch (error) {
      onError(`Could not open full screen: ${error.message}`);
    }
  });
  root.addEventListener("fullscreenchange", () => {
    const expanded = document.fullscreenElement === root;
    expand.setAttribute("aria-label", expanded ? "Exit full screen" : "Edit in full screen");
    expand.title = expanded ? "Exit full screen" : "Edit in full screen";
    expand.setAttribute("aria-pressed", String(expanded));
    numbered = 0;
    numberLines();
  });

  textarea.spellcheck = false;
  textarea.addEventListener("input", () => refresh());
  textarea.addEventListener("scroll", () => {
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
    gutter.scrollTop = textarea.scrollTop;
  });
  // The caret moves by typing, clicking, the arrow keys and selecting.
  for (const type of ["input", "click", "keyup", "select", "focus"]) {
    textarea.addEventListener(type, updatePosition);
  }
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === textarea) updatePosition();
  });
  // Ctrl+Enter (Cmd+Enter on a Mac) sends, or saves, without reaching for the mouse.
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      textarea.form?.requestSubmit();
    }
  });
  refresh({ immediate: true });
  showPosition();
  return { editor, refresh };
};
