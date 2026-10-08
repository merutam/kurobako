// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

/** Reveal a client-initialized page only after its first coherent state is ready. */
export const revealPage = () => {
  document.querySelector("main[data-loading]")?.removeAttribute("data-loading");
  document.querySelector("#page-loading")?.remove();
};

/** Keep the loading shell, but turn it into a readable, retryable error. */
export const failPage = (message) => {
  const loading = document.querySelector("#page-loading");
  if (!loading) return;
  const text = document.createElement("p");
  text.textContent = message;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => window.location.reload());
  loading.replaceChildren(text, retry);
};
