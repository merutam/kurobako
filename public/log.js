// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The server knows an encrypted namespace only by ID. The fragment that
// opened the log is never sent to it; use that fragment to link back locally.
import { decorateIcons } from "./icons.js";

decorateIcons();
const back = document.querySelector("#log-back");
if (back && window.location.hash) {
  const namespacePage = window.location.pathname.replace(/\/[^/]+\/log\/?$/, "");
  back.href = `${namespacePage}${window.location.hash}`;
  back.parentElement.hidden = false;
}
