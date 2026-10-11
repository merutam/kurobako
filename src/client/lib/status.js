// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { h } from "../shared/dom.js";

// A page's messages. The page's own status floats over the page, out of its
// flow, so it can go away by itself without moving anything: a success
// leaves after a few seconds (not while pointed at or focused), progress
// stays until the next message, and an error until dismissed, so it is
// never missed.
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
