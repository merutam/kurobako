// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The fragment never reaches the server, which knows an encrypted namespace only by ID.
import { splitFragment } from "../../../public/k.mjs";
import { finishUnlocking } from "../lib/unlocking.js";

const back = document.querySelector("#log-back");
if (back && window.location.hash) {
  const namespacePage = window.location.pathname.replace(/\/[^/]+\/log\/?$/, "");
  back.href = `${namespacePage}${window.location.hash}`;
  back.parentElement.hidden = false;
}

const title = document.querySelector("#log-title");
if (title && window.location.hash) {
  try {
    const { name } = splitFragment(window.location.hash.slice(1));
    if (name) {
      title.textContent = `/e#${name}`;
      document.title = `/e#${name} access log · Kurobako`;
    }
  } catch {}
}
finishUnlocking();
