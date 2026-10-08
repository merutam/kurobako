// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Syntax-highlighted native textareas and their language picker. The editable
// textarea stays in charge of selection, forms and accessibility; a copy below
// it only paints the syntax colors.
import { el } from "./common.js";
import { icon } from "./icons.js";
import { highlightedCode, lineNumbers, MAX_HIGHLIGHT_CHARACTERS } from "./items.js";
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

export const languageOptions = (selected) => {
  const options = [el("option", { value: "", textContent: "Plain text" })];
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
  if (selected && !options.some((option) => option.value === selected)) {
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

const addResizeHandle = (editor) => {
  const handle = el(
    "button",
    {
      type: "button",
      className: "text-resize-handle",
      ariaLabel: "Resize text editor",
      title: "Drag to resize; tap to expand or shrink",
    },
    icon("resize", 18),
  );
  const setHeight = (height) => {
    const minimum = Number.parseFloat(getComputedStyle(editor).minHeight);
    editor.style.height = `${Math.max(minimum, height)}px`;
  };
  let start = null;
  let dragged = false;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    start = { id: event.pointerId, y: event.clientY, height: editor.offsetHeight };
    dragged = false;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (event.pointerId !== start?.id) return;
    const distance = event.clientY - start.y;
    if (Math.abs(distance) > 3) dragged = true;
    if (dragged) setHeight(start.height + distance);
  });
  for (const type of ["pointerup", "pointercancel"]) {
    handle.addEventListener(type, (event) => {
      if (event.pointerId !== start?.id) return;
      start = null;
      if (type === "pointercancel") dragged = false;
    });
  }
  handle.addEventListener("click", () => {
    if (dragged) {
      dragged = false;
      return;
    }
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    setHeight(editor.offsetHeight < 22 * rem ? 28 * rem : 16 * rem);
  });
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setHeight(editor.offsetHeight + (event.key === "ArrowDown" ? 32 : -32));
  });
  editor.append(handle);
};

/**
 * Keeps a native textarea editable over a syntax-colored, scroll-synchronized
 * copy. The textarea's own letters are transparent, so the copy must follow
 * every keystroke: it is redrawn on the next frame with the selected grammar.
 * A text too large to color on every keystroke shows its letters at once and
 * its colors when typing pauses.
 */
export const createTextEditor = (textarea, { title = () => "" } = {}) => {
  const highlight = el("pre", { className: "text-editor-highlight", ariaHidden: true });
  const gutter = el("pre", { className: "text-editor-lines", ariaHidden: true });
  const emptySelection = el("div", { className: "text-editor-selection", ariaHidden: true });
  let lineCount = 0;
  let lineStarts = [0];
  let colorTimer = null;
  let frame = null;
  /** Whether coloring the whole text took too long to do on every keystroke. */
  let slow = false;
  const updateWrapping = () => {
    const markdown = /\.(?:md|markdown)$/i.test(title());
    editor.classList.toggle("markdown", markdown);
    textarea.setAttribute("wrap", markdown ? "soft" : "off");
  };

  const paint = (colored) => {
    const text = textarea.value;
    const source = title();
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
  };

  const refresh = ({ immediate = false } = {}) => {
    updateWrapping();
    const starts = [0];
    for (
      let at = textarea.value.indexOf("\n");
      at !== -1;
      at = textarea.value.indexOf("\n", at + 1)
    ) {
      starts.push(at + 1);
    }
    lineStarts = starts;
    const count = starts.length;
    if (count !== lineCount) {
      lineCount = count;
      gutter.textContent = lineNumbers(textarea.value);
      editor.style.setProperty("--line-number-width", `${Math.max(3, String(count).length)}ch`);
      gutter.scrollTop = textarea.scrollTop;
    }
    clearTimeout(colorTimer);
    if (immediate) {
      paint(true);
      updatePosition();
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
    updatePosition();
  };

  /**
   * Where the caret is: "12:5", and how much is selected, "12:5 (27)". The
   * caller puts it below the text, with the form's other details.
   */
  const position = el("span", { className: "text-editor-position", ariaHidden: true });
  let positionFrame = null;
  const showEmptySelection = () => {
    const { selectionStart: start, selectionEnd: end } = textarea;
    if (start === end || document.activeElement !== textarea) {
      emptySelection.replaceChildren();
      return;
    }
    const style = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const topOffset = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
    const left =
      Number.parseFloat(style.borderLeftWidth) +
      Number.parseFloat(style.paddingLeft) -
      textarea.scrollLeft;
    const first = Math.max(0, Math.floor((textarea.scrollTop - topOffset) / lineHeight));
    const last = Math.min(
      lineStarts.length - 2,
      Math.ceil((textarea.scrollTop + textarea.clientHeight - topOffset) / lineHeight),
    );
    const markers = [];
    for (let row = first; row <= last; row += 1) {
      const newline = lineStarts[row];
      if (lineStarts[row + 1] !== newline + 1 || newline < start || newline >= end) continue;
      const top = topOffset + row * lineHeight - textarea.scrollTop;
      const marker = el("span", { className: "text-editor-selected-empty-line" });
      marker.style.top = `${top}px`;
      marker.style.left = `${left}px`;
      marker.style.height = `${lineHeight}px`;
      markers.push(marker);
    }
    emptySelection.replaceChildren(...markers);
  };
  const showPosition = () => {
    positionFrame = null;
    const { selectionStart: start, selectionEnd: end } = textarea;
    const caret = textarea.selectionDirection === "backward" ? start : end;
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= caret) low = middle;
      else high = middle;
    }
    const line = low + 1;
    const column = caret - lineStarts[low] + 1;
    const selected = end - start;
    // Short, as editors write it (line:column), with the words on hover.
    position.textContent = `${line}:${column}${selected ? ` (${selected})` : ""}`;
    position.title = `Line ${line}, column ${column}${selected ? `, ${selected} selected` : ""}`;
    showEmptySelection();
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
    emptySelection,
  );
  addResizeHandle(editor);

  textarea.spellcheck = false;
  updateWrapping();
  textarea.addEventListener("input", () => refresh());
  textarea.addEventListener("scroll", () => {
    gutter.scrollTop = textarea.scrollTop;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
    updatePosition();
  });
  // A phone's keyboard composes a word before it is typed, and some browsers
  // tell the page only once it is done: meanwhile the textarea shows its own
  // letters (the colored copy cannot follow), then colors come back.
  textarea.addEventListener("compositionstart", () => editor.classList.add("composing"));
  textarea.addEventListener("compositionupdate", () => refresh());
  textarea.addEventListener("compositionend", () => {
    editor.classList.remove("composing");
    refresh({ immediate: true });
  });
  // The caret moves by typing, clicking, the arrow keys and selecting.
  for (const type of ["input", "click", "keyup", "select", "focus"]) {
    textarea.addEventListener(type, updatePosition);
  }
  textarea.addEventListener("blur", updatePosition);
  let alignTimer = null;
  const alignOnTouch = () => {
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    const form = textarea.closest("form");
    form?.scrollIntoView({ block: "start" });
    clearTimeout(alignTimer);
    // The keyboard may move the page again after the field receives focus.
    alignTimer = setTimeout(() => {
      if (document.activeElement === textarea) form?.scrollIntoView({ block: "start" });
    }, 300);
  };
  textarea.addEventListener("focus", alignOnTouch);
  textarea.addEventListener("click", alignOnTouch);
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
  return { editor, refresh, position };
};
