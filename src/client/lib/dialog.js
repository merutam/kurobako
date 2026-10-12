// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Instead of confirm(), so the button can say what the action does.

import { h } from "../shared/dom.js";

let dialogs = 0;

/** Cancel has the focus on destructive actions, so Enter alone never deletes. */
/** `subject`, the item's own words, sits apart from the fixed message so the two never blur. */
export const confirmAction = ({
  title,
  subject = "",
  message = "",
  confirm = "OK",
  cancel = "Cancel",
  destructive = false,
}) =>
  new Promise((resolve) => {
    const titleId = `dialog-title-${++dialogs}`;
    const subjectId = `${titleId}-subject`;
    const messageId = `${titleId}-message`;
    const cancelButton = h("button", { type: "submit", value: "cancel" }, cancel);
    const confirmButton = h(
      "button",
      { type: "submit", value: "confirm", class: destructive ? "danger" : "primary" },
      confirm,
    );
    const dialog = h(
      "dialog",
      {
        class: "dialog",
        role: "alertdialog",
        "aria-labelledby": titleId,
        "aria-describedby":
          [subject && subjectId, message && messageId].filter(Boolean).join(" ") || null,
      },
      h("h2", { id: titleId }, title),
      subject && h("p", { id: subjectId, class: "dialog-subject", title: subject }, subject),
      message && h("p", { id: messageId }, message),
      h("form", { method: "dialog", class: "dialog-actions" }, cancelButton, confirmButton),
    );
    // Outside the dialog's box is its backdrop.
    dialog.addEventListener("click", (event) => {
      const box = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (!inside) dialog.close("cancel");
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "confirm");
    });
    // As after the browser's own dialog.
    const before = document.activeElement;
    dialog.addEventListener("close", () => before?.focus?.({ preventScroll: true }));
    document.body.append(dialog);
    dialog.showModal();
    (destructive ? cancelButton : confirmButton).focus();
  });
