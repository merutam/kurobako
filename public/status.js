// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A page's messages. The page's own status floats over the page, out of its
// flow, so it can go away by itself without moving anything: a success
// leaves after a few seconds (not while pointed at or focused), progress
// stays until the next message, and an error until dismissed, so it is
// never missed. A status inside a form sits in the flow, by its fields, and
// stays until replaced.
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

    const text = document.createElement("span");
    text.textContent = message;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "status-dismiss";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.addEventListener("click", () => show(""));
    element.replaceChildren(text, dismiss);
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
