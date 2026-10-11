// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The server knows an encrypted namespace only by ID. The fragment that
// opened the log is never sent to it; use that fragment to link back locally
// and, when it holds the name (not a read-only link's token), to show it.
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
  } catch {
    // A fragment that is no name: the server's title stays.
  }
}
finishUnlocking();
