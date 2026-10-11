// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { secretNameProblem, splitFragment } from "../../../public/k.mjs";
// Namespace page entry point. Each feature owns its DOM and state; this file
// only wires them together and starts the selected plain or encrypted mode.
import {
  copyText,
  element,
  iconLink,
  ignoreStrayDrops,
  readConfig,
  SITE,
  setBusy,
} from "../lib/common.js";
import { loadHighlighter } from "../lib/highlight.js";
import { createStatus } from "../lib/status.js";
import { failUnlocking, finishUnlocking } from "../lib/unlocking.js";
import { createAccess } from "./namespace/access.js";
import { createForms } from "./namespace/forms.js";
import { createItemList } from "./namespace/item-list.js";
import { createLive } from "./namespace/live.js";
import { plainMode, sealedMode } from "./namespace/modes.js";

const status = createStatus(element("#status"));
const pageTitle = element("#page-title");
const pageLinks = element("#page-links");
const qrImage = element("#qr");

let items;
const access = createAccess();
let live;
items = createItemList({
  status,
  access,
  refreshUnlessLive: () => live.refreshUnlessLive(),
  loadItems: () => live.loadItems(),
});
// A plain namespace's page comes with its queue (see createLive).
const initial = document.getElementById("queue-data");
live = createLive({
  initial: initial ? JSON.parse(initial.textContent) : null,
  status,
  renderItems: items.renderItems,
  isItemsShown: items.isItemsShown,
  onReady: finishUnlocking,
  onError: failUnlocking,
});
const forms = createForms({
  status,
  writeHeaders: access.writeHeaders,
  refreshUnlessLive: () => live.refreshUnlessLive(),
});
ignoreStrayDrops();

const showPage = (mode) => {
  pageTitle.textContent = mode.title;
  pageLinks.replaceChildren(
    " · ",
    // An encrypted name or read token stays in the fragment, including when
    // the log's Back link returns to this page.
    iconLink(
      `${mode.basePath}/log${mode.label ? window.location.hash : ""}`,
      "Access log",
      "users",
    ),
    " · ",
    iconLink(`${mode.basePath}/ls`, "See JSON", "json"),
  );
  document.title = `${mode.title} · Kurobako`;
  // The encrypted name in this address must never be sent to the server.
  // The QR code's library loads apart: the code is at the bottom of the page.
  void import("../vendor/uqr.js").then(({ renderSVG }) => {
    qrImage.src = `data:image/svg+xml,${encodeURIComponent(renderSVG(mode.shareUrl, { ecc: "M", border: 2 }))}`;
  });
  forms.showPage();
  access.showAccess();
  element("#create-view").hidden = !access.canWrite();
};

const disableAll = (message) => {
  for (const selector of ["#text-form", "#file-form", "#restore-form"]) {
    setBusy(element(selector), true);
  }
  for (const selector of ["#backup-zip", "#backup-tar", "#refresh"]) {
    element(selector).disabled = true;
  }
  status.error(message);
};

// The secret name only exists in the fragment; editing it means another space.
window.addEventListener("hashchange", () => window.location.reload());

try {
  const config = readConfig();
  items.setConfig(config);
  live.setConfig(config);
  forms.setConfig(config);

  const path = window.location.pathname.slice(SITE.length);
  let mode;
  if (path === "/e") {
    // A read-only link is #/<token>; a name may be followed by a CLI command.
    const { name: secretName, readToken } = splitFragment(window.location.hash.slice(1));
    if (!secretName && !readToken) {
      throw new Error("Missing name. Open an encrypted namespace from the home page.");
    }
    if (!readToken) {
      const problem = secretNameProblem(secretName, config.sealed.maxNameLength);
      if (problem) throw new Error(problem);
    }
    status.progress("Unlocking…");
    element("#page-loading").lastElementChild.textContent = "Unlocking namespace…";
    mode = await sealedMode({ secretName, readToken }, access.writeHeaders);
    status.clear();
  } else {
    mode = plainMode(decodeURIComponent(path.split("/")[1] || ""), access.writeHeaders);
  }

  access.setMode(mode);
  items.setMode(mode);
  live.setMode(mode);
  forms.setMode(mode);
  showPage(mode);
  element("#create-view").addEventListener("click", async () => {
    const create = element("#create-view");
    create.disabled = true;
    status.progress("Creating a shared view…");
    try {
      const url = await mode.createView();
      element("#view-link").value = url;
      element("#view-link-row").hidden = false;
      status.success("Shared view created. The previous view, if any, is now frozen.");
    } catch (error) {
      status.error(error.message);
    } finally {
      create.disabled = false;
    }
  });
  element("#copy-view-link").addEventListener("click", async () => {
    try {
      await copyText(element("#view-link").value);
      status.success("Shared view link copied.");
    } catch (error) {
      status.error(error.message);
    }
  });
  await live.showInitial();
  // The send form colors as you type: fetch highlight.js once the page is up.
  (window.requestIdleCallback ?? setTimeout)(() => void loadHighlighter().catch(() => {}));
  // Connect before any /ls, so changes during that fetch are buffered.
  live.connectLive();
  setInterval(items.updateExpiries, 30_000);
} catch (error) {
  disableAll(error.message);
  failUnlocking(error.message);
}
