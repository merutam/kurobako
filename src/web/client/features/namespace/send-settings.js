// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { element } from "../../lib/common.js";

/** The settings popup: burn after reading and expiry, for sends only. */
export const createSendSettings = () => {
  const burnInput = element("#burn");
  const expiresInput = element("#expires-in");
  const settingsBox = element("#send-settings");
  const settingsState = element("#settings-state");
  // Says what differs from the defaults, so a send never surprises.
  const show = () => {
    const changed = [
      burnInput.checked && "once",
      expiresInput.value && expiresInput.selectedOptions[0]?.textContent,
    ].filter(Boolean);
    settingsState.textContent = changed.join(" · ");
  };
  burnInput.addEventListener("change", show);
  expiresInput.addEventListener("change", show);
  // A page brought back from history may keep what was picked before.
  show();
  return {
    values: () => ({ burn: burnInput.checked, expiresIn: expiresInput.value || null }),
    /** Burn and expiry are a send's; an edit keeps the item's. */
    setHidden(hidden) {
      settingsBox.hidden = hidden;
    },
  };
};
