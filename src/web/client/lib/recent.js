// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// For the share page to offer. Kept on this device only, and each can be forgotten.

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
