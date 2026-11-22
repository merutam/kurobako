// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What the namespace list and the shared item page both do with an item.
import { copyText } from "./common.js";
import { copyImage } from "./items.js";

/** `content`: text or an image Blob (or a promise of one), copied with a status line. */
export const copyWithStatus = async (status, content) => {
  try {
    const value = await content;
    if (typeof value === "string") await copyText(value);
    else await copyImage(value);
    status.success("Copied.");
  } catch (error) {
    status.error(error.message);
  }
};

/** After an item with limited reads was opened. */
export const openedMessage = (item) =>
  item.burn || item.readsLeft === 1
    ? "Opened and deleted from the server."
    : "Opened; one read used.";

/** The server answers 404 once the last read is gone. */
export const openFailure = (error, gone) =>
  error.message === "Item not found." ? gone : error.message;
