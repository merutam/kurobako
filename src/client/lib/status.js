// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { h } from "../shared/dom.js";

// Floats over the page, so it can go away without moving anything. Errors stay
// until dismissed, so they are never missed.
const SUCCESS_SECONDS = 4;

export const createStatus = (element) => {
  const floating = !element.closest("fieldset");
  let timer = null;
  let kind = "";

  const stopTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const startTimer = () => {
    stopTimer();
    if (floating && kind === "success") timer = setTimeout(() => show(""), SUCCESS_SECONDS * 1000);
  };

  const show = (message, newKind = "") => {
    stopTimer();
    kind = message ? newKind : "";
    element.classList.toggle("error", kind === "error");
    if (kind) element.dataset.kind = kind;
    else delete element.dataset.kind;
    if (!message) {
      element.replaceChildren();
      return;
    }

    const dismiss = h(
      "button",
      { type: "button", class: "status-dismiss", "aria-label": "Dismiss" },
      "×",
    );
    dismiss.addEventListener("click", () => show(""));
    element.replaceChildren(h("span", {}, message), dismiss);
    startTimer();
  };

  // Someone reading or about to dismiss it keeps it there.
  element.addEventListener("mouseenter", stopTimer);
  element.addEventListener("mouseleave", startTimer);
  element.addEventListener("focusin", stopTimer);
  element.addEventListener("focusout", startTimer);

  return {
    success: (message) => show(message, "success"),
    progress: (message) => show(message, "progress"),
    error: (message) => show(message, "error"),
    clear: () => show(""),
    isError: () => kind === "error",
  };
};
