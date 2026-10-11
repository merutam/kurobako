// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What is shared to the installed app. public/sw.js takes the share target's
// POST and keeps it in this cache, on the device: <site>/k/share/<id> holds
// its title, text, link and file names (JSON), <id>/<n> each file.

import { SITE } from "./common.js";

const SHARE_CACHE = "kurobako-shares";
const ID_PATTERN = /^[0-9a-f]{32}$/;
const addressOf = (id) => `${window.location.origin}${SITE}/k/share/${id}`;

/** A share: { title, text, url, files }, or null when it is gone (or never was). */
export const readShare = async (id) => {
  if (!ID_PATTERN.test(id ?? "") || !globalThis.caches) return null;
  const cache = await caches.open(SHARE_CACHE);
  const details = await cache.match(addressOf(id));
  if (!details) return null;
  const { title, text, url, files } = await details.json();
  const opened = await Promise.all(
    files.map(async ({ name, type }, index) => {
      const body = await cache.match(`${addressOf(id)}/${index}`);
      return body ? new File([await body.blob()], name, { type }) : null;
    }),
  );
  return { title, text, url, files: opened.filter(Boolean) };
};

/** Forgets a share, once it is in a composer or discarded. */
export const dropShare = async (id) => {
  if (!ID_PATTERN.test(id ?? "") || !globalThis.caches) return;
  const cache = await caches.open(SHARE_CACHE);
  const address = addressOf(id);
  for (const request of await cache.keys()) {
    if (request.url === address || request.url.startsWith(`${address}/`)) {
      await cache.delete(request);
    }
  }
};
