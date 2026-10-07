// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { copyText, element, request, storage } from "../common.js";

export const createAccess = ({ status, renderItems, getServerItems }) => {
  const sendSection = element("#send-section");
  const restore = element("#restore-form");
  const burnInput = element("#burn");
  const burnHint = element("#burn-hint");
  const modeLabel = element("#mode-label");
  const lockSection = element("#lock-section");
  const lockActions = element("#lock-actions");
  const lockHint = element("#lock-hint");
  const lockLinkRow = element("#lock-link-row");
  const lockLink = element("#lock-link");
  const keyForm = element("#key-form");
  const keyInput = element("#key-input");
  const unlockButton = element("#unlock-button");
  const forgetKeyButton = element("#forget-key");
  let mode = null;
  /*
   * Write access. A locked namespace is read by anyone and written only with
   * its key, sent as Write-Key. The key is kept on this device, by namespace;
   * an owner's link brings it in its fragment (#w=<key>), never to the server.
   */
  /**
   * Whether the namespace is locked: true or false, or null while unknown (a
   * read-only link, until the queue comes). The server marks a locked plain
   * namespace's page (data-locked), so its state is known from the start.
   */
  let locked = document.querySelector("main")?.hasAttribute("data-locked")
    ? true
    : window.location.hash.startsWith("#/")
      ? null
      : false;
  const writeKeyName = () => `kurobako-write:${mode.basePath}`;
  /** A plain namespace's key is kept on this device; an encrypted one's comes from its name. */
  const writeKey = () =>
    mode.writeKey !== undefined ? mode.writeKey : storage.get(writeKeyName());
  const writeHeaders = () => (writeKey() ? { "Write-Key": writeKey() } : {});
  /** Whether this page may write: an open namespace, or a locked one whose key it has. */
  const canWrite = () => locked === false || Boolean(writeKey());

  /** Shows what this page may do: send, or only read, and the lock controls. */
  const showAccess = () => {
    const readOnly = !canWrite();
    // From here on the forms' hidden attribute says it: the marks that hid
    // them before the first paint (see access.js) are done with.
    document.documentElement.removeAttribute("data-read-link");
    document.querySelector("main")?.removeAttribute("data-locked");
    sendSection.hidden = readOnly;
    restore.hidden = readOnly;
    // A locked namespace has no items that delete when opened.
    burnInput.disabled = locked || readOnly;
    if (locked) burnInput.checked = false;
    burnHint.textContent = locked
      ? "Unavailable while this namespace is locked."
      : readOnly
        ? "Only writers can use this setting."
        : "New items sent while enabled are deleted when first opened.";
    modeLabel.textContent = [mode.label, locked ? (readOnly ? "Read-only" : "Locked") : ""]
      .filter(Boolean)
      .map((part) => `${part} · `)
      .join("");

    const key = writeKey();
    const sealed = mode.writeKey !== undefined;
    // Only existing locks have controls while creating locks is paused.
    lockSection.hidden = !locked || (sealed && !key);
    unlockButton.hidden = !locked || !key;
    // An encrypted namespace's key is its name: nothing to forget or type in.
    forgetKeyButton.hidden = sealed || !locked || !key;
    lockActions.hidden = unlockButton.hidden && forgetKeyButton.hidden;
    keyForm.hidden = sealed || !locked || Boolean(key);
    lockLinkRow.hidden = !locked || !key;
    if (sealed) {
      lockLink.value = mode.readOnlyUrl;
      lockLink.setAttribute("aria-label", "Read-only link");
      lockHint.textContent =
        "Locked: the read-only link below opens it for reading only; the name still writes.";
      return;
    }
    lockLink.setAttribute("aria-label", "Link that writes here");
    if (locked && key) {
      lockLink.value = `${mode.shareUrl}#w=${encodeURIComponent(key)}`;
      lockHint.textContent =
        "Locked: anyone can read it, and this device writes. So does the link below: keep it to yourself.";
    } else if (locked) {
      lockHint.textContent =
        "Read-only: only those with its write key can send, edit, rename or delete here.";
    }
  };

  /** The lock as the server says it, from the queue or the live connection. */
  const setLocked = (value) => {
    if (value === locked) return;
    locked = value;
    showAccess();
    void renderItems(getServerItems(), { force: true });
  };

  unlockButton.addEventListener("click", async () => {
    if (!window.confirm("Unlock? Anyone with the name could then send, edit, rename and delete."))
      return;
    try {
      await request(`${mode.basePath}/lock`, { method: "DELETE", headers: writeHeaders() });
      if (mode.writeKey === undefined) storage.remove(writeKeyName());
      status.success("Unlocked.");
      setLocked(false);
      showAccess();
    } catch (error) {
      status.error(error.message);
    }
  });

  forgetKeyButton.addEventListener("click", () => {
    storage.remove(writeKeyName());
    showAccess();
    void renderItems(getServerItems(), { force: true });
  });

  keyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    storage.set(writeKeyName(), keyInput.value.trim());
    keyForm.reset();
    status.success("Key saved on this device: writing tells whether it is the right one.");
    showAccess();
    void renderItems(getServerItems(), { force: true });
  });

  element("#copy-lock-link").addEventListener("click", async () => {
    try {
      await copyText(lockLink.value);
      status.success(
        mode.writeKey !== undefined
          ? "Read-only link copied."
          : "Link copied: it writes here, keep it to yourself.",
      );
    } catch (error) {
      status.error(error.message);
    }
  });

  return {
    setMode(value) {
      mode = value;
    },
    storeOwnerKey(key) {
      storage.set(writeKeyName(), key);
    },
    writeHeaders,
    canWrite,
    setLocked,
    showAccess,
  };
};
