// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { h } from "../shared/dom.js";

/** Reveal the namespace after its name has been unlocked and its first list is ready. */
export const finishUnlocking = () => {
  document.querySelector("main[data-loading]")?.removeAttribute("data-loading");
  document.querySelector("#page-loading")?.remove();
};

/** Keep the unlocking shell, but turn it into a readable, retryable error. */
export const failUnlocking = (message) => {
  const loading = document.querySelector("#page-loading");
  if (!loading) return;
  loading.hidden = false;
  const retry = h("button", { type: "button" }, "Retry");
  retry.addEventListener("click", () => window.location.reload());
  loading.replaceChildren(h("p", {}, message), retry);
};
