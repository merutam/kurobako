// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The namespaces this device sent to lately, newest first, for the share
// page to offer: { url, title }, an encrypted one's url with its secret name
// after the #, as the browser's history keeps it too. Kept here only, and
// each can be forgotten.

import { storage } from "./common.js";

const RECENT_KEY = "kurobako-recent";
const MAX_RECENT = 8;

export const recentNamespaces = () => {
  try {
    const list = JSON.parse(storage.get(RECENT_KEY) ?? "[]");
    return Array.isArray(list)
      ? list.filter((entry) => typeof entry?.url === "string" && typeof entry?.title === "string")
      : [];
  } catch {
    return [];
  }
};

/** Puts a namespace first. */
export const rememberNamespace = ({ url, title }) =>
  storage.set(
    RECENT_KEY,
    JSON.stringify(
      [{ url, title }, ...recentNamespaces().filter((entry) => entry.url !== url)].slice(
        0,
        MAX_RECENT,
      ),
    ),
  );

export const forgetNamespace = (url) =>
  storage.set(RECENT_KEY, JSON.stringify(recentNamespaces().filter((entry) => entry.url !== url)));
