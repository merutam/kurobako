// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Off unless turned on, per namespace and device. One subscription serves the
// whole site; the cache lists followed namespaces so sw.js can name a
// notification and know where a tap leads.

import { request, SITE } from "./common.js";

const PUSH_CACHE = "kurobako-push";
const recordAddress = (key) => `${window.location.origin}${SITE}/k/push/${key}`;

const fromBase64Url = (text) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  );
const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export const pushAvailable = (config) =>
  Boolean(
    config.push &&
      window.isSecureContext &&
      navigator.serviceWorker &&
      "PushManager" in window &&
      "Notification" in window &&
      globalThis.caches,
  );

const registration = () => navigator.serviceWorker.register(`${SITE}/sw.js`, { scope: `${SITE}/` });

const subscription = async () => (await registration()).pushManager.getSubscription();

/** As the server computes it (skipIdOf). */
const skipIdOf = async (endpoint) =>
  toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint))).slice(
      0,
      16,
    ),
  );

let skipId = null;

/** So this device is not told of its own sends. */
export const pushSkipHeaders = () => (skipId ? { "Push-Skip": skipId } : {});

export const following = async (key) => {
  const current = await subscription().catch(() => null);
  skipId = current ? await skipIdOf(current.endpoint) : null;
  if (!current || Notification.permission !== "granted") return false;
  return Boolean(await (await caches.open(PUSH_CACHE)).match(recordAddress(key)));
};

export const follow = async ({ key, basePath, url, title, publicKey }) => {
  if ((await Notification.requestPermission()) !== "granted") {
    throw new Error(
      "Notifications are blocked for this site: allow them in the browser's settings.",
    );
  }
  const pushManager = (await registration()).pushManager;
  const serverKey = fromBase64Url(publicKey);
  let current = await pushManager.getSubscription();
  // Made for another server key: made again.
  const madeFor = current?.options.applicationServerKey;
  if (madeFor && toBase64Url(new Uint8Array(madeFor)) !== publicKey) {
    await current.unsubscribe();
    current = null;
  }
  current ??= await pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: serverKey,
  });
  await request(`${basePath}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(current.toJSON()),
  });
  await (await caches.open(PUSH_CACHE)).put(recordAddress(key), Response.json({ url, title }));
  skipId = await skipIdOf(current.endpoint);
};

/** Following nothing, the subscription goes too. */
export const unfollow = async ({ key, basePath }) => {
  const current = await subscription();
  if (current) {
    await request(`${basePath}/push?off`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: current.endpoint }),
    });
  }
  const cache = await caches.open(PUSH_CACHE);
  await cache.delete(recordAddress(key));
  if (current && !(await cache.keys()).length) {
    await current.unsubscribe();
    skipId = null;
  }
};
