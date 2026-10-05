// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The status line under each page title. It sits in the page flow, so it
// never disappears by itself (that would make everything below it jump): a
// message stays until the next one replaces it or the user dismisses it.
export const createStatus = (element) => {
  const show = (message, kind) => {
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
  };

  return {
    success: (message) => show(message, "success"),
    progress: (message) => show(message, "progress"),
    error: (message) => show(message, "error"),
    clear: () => show(""),
    isError: () => element.classList.contains("error"),
  };
};
