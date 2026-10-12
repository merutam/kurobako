// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { secretNameProblem, splitFragment } from "../../../public/k.mjs";
// Each feature owns its DOM and state; this only wires them together.
import { copyText, element, ignoreStrayDrops, readConfig, SITE, setBusy } from "../lib/common.js";
import { loadHighlighter } from "../lib/highlight.js";
import { follow, following, pushAvailable, unfollow } from "../lib/push.js";
import { rememberNamespace } from "../lib/recent.js";
import { dropShare, readShare } from "../lib/shares.js";
import { createStatus } from "../lib/status.js";
import { failUnlocking, finishUnlocking } from "../lib/unlocking.js";
import { h } from "../shared/dom.js";
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
  onEdit: (entry) => forms.edit(entry),
});
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
  // An encrypted page learns its name and address from the fragment.
  if (mode.label) {
    pageTitle.textContent = mode.title;
    pageLinks.replaceChildren(
      // The name stays in the fragment, so the log's Back link can return here.
      h("a", { href: `${mode.basePath}/log${window.location.hash}` }, "Access log"),
      " · ",
      h("a", { href: `${mode.basePath}/ls` }, "As JSON"),
    );
    document.title = `${mode.title} · Kurobako`;
  }
  // The QR library loads apart: the code is at the bottom of the page.
  void import("../vendor/uqr.js").then(({ renderSVG }) => {
    qrImage.src = `data:image/svg+xml,${encodeURIComponent(renderSVG(mode.shareUrl, { ecc: "M", border: 2 }))}`;
  });
  forms.showPage();
  access.showAccess();
  element("#create-view").hidden = !access.canWrite();
};

const disableAll = (message) => {
  for (const selector of ["#send-form", "#restore-form"]) {
    setBusy(element(selector), true);
  }
  for (const selector of ["#backup-zip", "#backup-tar"]) {
    element(selector).disabled = true;
  }
  status.error(message);
};

window.addEventListener("hashchange", () => window.location.reload());

try {
  const config = readConfig();
  items.setConfig(config);
  live.setConfig(config);
  forms.setConfig(config);

  const path = window.location.pathname.slice(SITE.length);
  let mode;
  if (path === "/e") {
    const { name: secretName, readToken } = splitFragment(window.location.hash.slice(1));
    if (!secretName && !readToken) {
      throw Object.assign(new Error("This link has no name after its #."), {
        retry: false,
      });
    }
    if (!readToken) {
      const problem = secretNameProblem(secretName, config.sealed.maxNameLength);
      if (problem) throw Object.assign(new Error(problem), { retry: false });
    }
    mode = await sealedMode({ secretName, readToken }, access.writeHeaders);
  } else {
    mode = plainMode(decodeURIComponent(path.split("/")[1] || ""), access.writeHeaders);
  }

  access.setMode(mode);
  items.setMode(mode);
  live.setMode(mode);
  forms.setMode(mode);
  showPage(mode);
  if (pushAvailable(config)) {
    const toggle = element("#notify-toggle");
    const show = (on) => {
      toggle.textContent = on ? "notify: on" : "notify: off";
      toggle.setAttribute("aria-pressed", String(on));
      toggle.title = on ? "Stop notifications on this device" : "Notify this device of new items";
    };
    const target = {
      key: mode.pushKey,
      basePath: mode.basePath,
      url: mode.shareUrl,
      title: mode.title,
      publicKey: config.push.publicKey,
    };
    show(await following(mode.pushKey).catch(() => false));
    toggle.hidden = false;
    toggle.addEventListener("click", async () => {
      const on = toggle.getAttribute("aria-pressed") !== "true";
      toggle.disabled = true;
      try {
        if (on) await follow(target);
        else await unfollow(target);
        show(on);
        status.success(on ? "This device is notified of new items here." : "Notifications off.");
      } catch (error) {
        status.error(error.message);
      } finally {
        toggle.disabled = false;
      }
    });
  }
  if (access.canWrite()) rememberNamespace({ url: mode.shareUrl, title: mode.title });
  const shareId = new URLSearchParams(window.location.search).get("share");
  if (shareId) {
    // Off the address, so a reload does not bring it back.
    const address = new URL(window.location.href);
    address.searchParams.delete("share");
    window.history.replaceState(null, "", address.href);
    const shared = await readShare(shareId).catch(() => null);
    if (!shared) status.error("That share is gone: share it again.");
    else if (!access.canWrite()) status.error("This namespace is read-only here: share it again.");
    else {
      forms.takeShare(shared);
      await dropShare(shareId);
      status.success("Shared here: check it, then Send.");
    }
  }
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
  // The send form colors as you type.
  (window.requestIdleCallback ?? setTimeout)(() => void loadHighlighter().catch(() => {}));
  // Before any /ls, so changes during that fetch are buffered.
  live.connectLive();
  // After the queue shows, which for an encrypted one comes after connecting.
  const copyId = new URLSearchParams(window.location.search).get("copy");
  if (copyId) {
    const address = new URL(window.location.href);
    address.searchParams.delete("copy");
    window.history.replaceState(null, "", address.href);
    // A queue that never loads must not hold up the page.
    void items.firstShown.then(() => items.copyById(copyId));
  }
  setInterval(items.updateExpiries, 30_000);
} catch (error) {
  disableAll(error.message);
  failUnlocking(error.message, { retry: error.retry !== false });
}
