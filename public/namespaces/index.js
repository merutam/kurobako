// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Namespace page entry point. Each feature owns its DOM and state; this file
// only wires them together and starts the selected plain or encrypted mode.
import { element, iconLink, readConfig, SITE, setBusy } from "../common.js";
import { ignoreStrayDrops } from "../components.js";
import { secretNameProblem, splitFragment } from "../k.mjs";
import { createStatus } from "../status.js";
import { renderSVG } from "../vendor/uqr.js";
import { createAccess } from "./access.js";
import { createForms } from "./forms.js";
import { createItemList } from "./item-list.js";
import { createLive, LIVE_FIRST_QUEUE_MS } from "./live.js";
import { plainMode, sealedMode } from "./modes.js";

const status = createStatus(element("#status"));
const pageTitle = element("#page-title");
const pageLinks = element("#page-links");
const qrImage = element("#qr");

let items;
const access = createAccess({
  status,
  renderItems: (...args) => items.renderItems(...args),
  getServerItems: () => items.getServerItems(),
});
let live;
items = createItemList({
  status,
  access,
  refreshUnlessLive: () => live.refreshUnlessLive(),
  loadItems: () => live.loadItems(),
});
live = createLive({
  status,
  renderItems: items.renderItems,
  setLocked: access.setLocked,
  isItemsShown: items.isItemsShown,
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
  qrImage.src = `data:image/svg+xml,${encodeURIComponent(renderSVG(mode.shareUrl, { ecc: "M", border: 2 }))}`;
  forms.showPage();
  access.showAccess();
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
    mode = await sealedMode({ secretName, readToken }, access.writeHeaders);
    status.clear();
  } else {
    mode = plainMode(decodeURIComponent(path.split("/")[1] || ""), access.writeHeaders);
  }

  access.setMode(mode);
  items.setMode(mode);
  live.setMode(mode);
  forms.setMode(mode);
  if (path !== "/e") {
    // An owner's link: keep its key here, then remove it from the address.
    const ownerKey = /^#w=(.+)$/.exec(window.location.hash)?.[1];
    if (ownerKey) {
      access.storeOwnerKey(decodeURIComponent(ownerKey));
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }

  showPage(mode);
  // The live connection brings the queue; the fetch is the fallback.
  live.connectLive();
  setTimeout(() => {
    if (!items.isItemsShown()) void live.loadItems();
  }, LIVE_FIRST_QUEUE_MS);
  setInterval(items.updateExpiries, 30_000);
} catch (error) {
  disableAll(error.message);
}
