// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { h } from "../shared/dom.js";

export const finishUnlocking = () => {
  document.querySelector("main[data-loading]")?.removeAttribute("data-loading");
  document.querySelector("#page-loading")?.remove();
};

/** A missing or invalid name links home: trying again cannot help. */
export const failUnlocking = (message, { retry = true } = {}) => {
  const loading = document.querySelector("#page-loading");
  if (!loading) return;
  loading.hidden = false;
  let next;
  if (retry) {
    next = h("button", { type: "button" }, "Retry");
    next.addEventListener("click", () => window.location.reload());
  } else {
    next = h(
      "a",
      { href: `${document.documentElement.dataset.base ?? ""}/` },
      "Open the home page",
    );
  }
  loading.replaceChildren(h("p", {}, message), next);
};
