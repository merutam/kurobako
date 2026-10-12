// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { h } from "../shared/dom.js";
import { icon } from "../shared/icons.js";
// The textarea keeps selection, forms and accessibility; a copy below only paints colors.

import { highlighter, withHighlighter } from "./highlight.js";
import { highlightedCode, MAX_HIGHLIGHT_CHARACTERS } from "./items.js";

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

const languageOptions = (selected) => {
  const hljs = highlighter();
  const options = [h("option", { value: "" }, "Plain text")];
  for (const language of hljs?.listLanguages() ?? []) {
    const details = hljs.getLanguage(language);
    const extension = PREFERRED_EXTENSIONS[language] ?? language;
    options.push(h("option", { value: extension }, `${details?.name ?? language} · .${extension}`));
  }
  if (selected && !options.some((option) => option.value === selected)) {
    const details = hljs?.getLanguage(selected);
    options.splice(
      1,
      0,
      h("option", { value: selected }, `${details?.name ?? selected} · .${selected}`),
    );
  }
  return options;
};

export const fillLanguages = (select, selected) => {
  // Later fills keep what has been picked since.
  let first = true;
  const fill = () => {
    const value = first ? selected : select.value || selected;
    first = false;
    select.replaceChildren(...languageOptions(selected));
    select.value = value;
  };
  fill();
  if (!highlighter()) withHighlighter(fill);
};

export const withExtension = (title, extension) => {
  const base = title.replace(/\.[A-Za-z0-9_+-]+$/, "");
  return extension ? `${base}.${extension}` : base;
};

const addResizeHandle = (editor) => {
  const handle = h(
    "button",
    {
      type: "button",
      class: "text-resize-handle",
      "aria-label": "Resize text editor",
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

/** The textarea's letters are transparent, so the copy must follow every keystroke. */
export const createTextEditor = (textarea, { title = () => "" } = {}) => {
  const highlight = h("pre", { class: "text-editor-highlight", "aria-hidden": "true" });
  const gutterText = h("span");
  const gutter = h("pre", { class: "text-editor-lines", "aria-hidden": "true" }, gutterText);
  const emptySelection = h("div", { class: "text-editor-selection", "aria-hidden": "true" });
  let lineCount = 0;
  let lineStarts = [0];
  let wrapping = false;
  let gutterWrapped = false;
  let colorTimer = null;
  let frame = null;
  /** Large texts color only when typing pauses. */
  let slow = false;
  // The contents, not their <pre>: its scrollTop would clamp before the textarea's.
  const syncScroll = () => {
    const x = textarea.scrollLeft;
    const y = textarea.scrollTop;
    gutterText.style.transform = `translateY(${-y}px)`;
    const code = highlight.firstElementChild;
    if (code) code.style.transform = `translate(${-x}px, ${-y}px)`;
  };
  const updateWrapping = () => {
    wrapping = /\.(?:md|markdown)$/i.test(title());
    editor.classList.toggle("markdown", wrapping);
    textarea.setAttribute("wrap", wrapping ? "soft" : "off");
  };
  // Wrapped lines carry a hidden copy of their text, so each number's row grows
  // as tall as the line it numbers.
  const renderGutter = () => {
    const text = textarea.value;
    const rows = lineStarts.map((start, index) => {
      const end = index + 1 < lineStarts.length ? lineStarts[index + 1] - 1 : text.length;
      return h(
        "span",
        { class: "text-editor-line" },
        h("span", {}, String(index + 1)),
        wrapping ? h("span", { class: "text-editor-line-text" }, text.slice(start, end)) : null,
      );
    });
    gutterText.replaceChildren(...rows);
    gutterWrapped = wrapping;
  };
  // The textarea's scrollbar narrows its text, so the copies wrap at its width.
  const measureTextWidth = () => {
    const style = getComputedStyle(textarea);
    const width =
      textarea.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    editor.style.setProperty("--text-width", `${width}px`);
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
      code = h("code", { class: "hljs" }, text);
    }
    // Keeps the last empty line visible when the textarea scrolls to the bottom.
    if (text.endsWith("\n")) code.append(" ");
    highlight.replaceChildren(code);
    syncScroll();
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
      editor.style.setProperty("--line-number-width", `${Math.max(3, String(count).length)}ch`);
    }
    if (wrapping) measureTextWidth();
    if (wrapping || gutterWrapped || gutterText.childElementCount !== count) {
      renderGutter();
      syncScroll();
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

  const lineAt = (offset) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle;
    }
    return low;
  };
  const position = h("span", { class: "text-editor-position", "aria-hidden": "true" });
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
    const rows = gutterText.children;
    const markers = [];
    for (let row = lineAt(start); row <= Math.min(lineAt(end), lineStarts.length - 2); row += 1) {
      const newline = lineStarts[row];
      if (lineStarts[row + 1] !== newline + 1 || newline < start || newline >= end) continue;
      // Rows stand in the gutter as tall as their wrapped lines.
      const top = topOffset + rows[row].offsetTop - rows[0].offsetTop - textarea.scrollTop;
      if (top + lineHeight < 0 || top > textarea.clientHeight) continue;
      const marker = h("span", { class: "text-editor-selected-empty-line" });
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
    const index = lineAt(caret);
    const line = index + 1;
    const column = caret - lineStarts[index] + 1;
    const selected = end - start;
    position.textContent = `${line}:${column}${selected ? ` (${selected})` : ""}`;
    position.title = `Line ${line}, column ${column}${selected ? `, ${selected} selected` : ""}`;
    showEmptySelection();
  };
  const updatePosition = () => {
    if (positionFrame === null) positionFrame = requestAnimationFrame(showPosition);
  };

  const editor = h("div", { class: "text-editor" }, gutter, highlight, textarea, emptySelection);
  addResizeHandle(editor);

  textarea.spellcheck = false;
  updateWrapping();
  textarea.addEventListener("input", () => refresh());
  // A new width rewraps every line, and the scrollbar coming or going changes it.
  new ResizeObserver(() => {
    if (wrapping) refresh();
  }).observe(textarea);
  textarea.addEventListener("scroll", () => {
    syncScroll();
    updatePosition();
  });
  // Phone keyboards compose before telling the page: the textarea shows its own
  // letters meanwhile, since the colored copy cannot follow.
  textarea.addEventListener("compositionstart", () => editor.classList.add("composing"));
  textarea.addEventListener("compositionupdate", () => refresh());
  textarea.addEventListener("compositionend", () => {
    editor.classList.remove("composing");
    refresh({ immediate: true });
  });
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
