// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Shared by every page: offer a way back only when the reader scrolls upward.
const button = document.querySelector("#scroll-top");
let lastY = window.scrollY;

window.addEventListener(
  "scroll",
  () => {
    const y = window.scrollY;
    const threshold = window.innerHeight / 2;
    if (y <= threshold) button.hidden = true;
    else if (y < lastY - 6) button.hidden = false;
    else if (y > lastY + 6) button.hidden = true;
    if (Math.abs(y - lastY) > 6 || y <= threshold) lastY = y;
  },
  { passive: true },
);

button.addEventListener("click", () => {
  window.scrollTo({
    top: 0,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
});
