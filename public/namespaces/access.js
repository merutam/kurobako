// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { element } from "../common.js";

/** A plain address writes; an encrypted name derives a separate write key. */
export const createAccess = () => {
  const sendSection = element("#send-section");
  const restore = element("#restore-form");
  const burnInput = element("#burn");
  const expiresInput = element("#expires-in");
  const modeLabel = element("#mode-label");
  let mode = null;

  const canWrite = () => mode.writeKey === undefined || Boolean(mode.writeKey);
  const writeHeaders = () => (mode?.writeKey ? { "Write-Key": mode.writeKey } : {});
  const showAccess = () => {
    const readOnly = !canWrite();
    document.documentElement.removeAttribute("data-read-link");
    sendSection.hidden = readOnly;
    restore.hidden = readOnly;
    burnInput.disabled = readOnly;
    expiresInput.disabled = readOnly;
    modeLabel.textContent = `${mode.label}${readOnly ? " · Read-only" : ""}${mode.label || readOnly ? " · " : ""}`;
  };

  return {
    setMode(value) {
      mode = value;
    },
    writeHeaders,
    canWrite,
    showAccess,
  };
};
