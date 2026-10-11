// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Push notifications of a namespace's sends (src/core/push.ts), off unless
// turned on, per namespace and device. The browser keeps one subscription
// for the whole site; the namespaces it follows are each told of it, and
// listed here, in a cache public/sw.js reads to name a notification and to
// know where a tap on it leads ({ url, title }, by "<space>:<name>").

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

/** Whether this browser and server can do it at all. */
export const pushAvailable = (config) =>
  Boolean(
    config.push &&
      window.isSecureContext &&
      navigator.serviceWorker &&
      "PushManager" in window &&
      "Notification" in window &&
      globalThis.caches,
  );

/** The Service Worker's registration (head/parts/service-worker.js registers it too). */
const registration = () => navigator.serviceWorker.register(`${SITE}/sw.js`, { scope: `${SITE}/` });

/** This device's subscription, if any. */
const subscription = async () => (await registration()).pushManager.getSubscription();

/** As the server computes it (skipIdOf): which device a send comes from. */
const skipIdOf = async (endpoint) =>
  toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint))).slice(
      0,
      16,
    ),
  );

let skipId = null;

/**
 * Sends from this device carry its subscription's ID, so it is not told of
 * what it sent itself (see modes.js).
 */
export const pushSkipHeaders = () => (skipId ? { "Push-Skip": skipId } : {});

/** Whether this device is told of `key`'s sends. Learns the device's ID on the way. */
export const following = async (key) => {
  const current = await subscription().catch(() => null);
  skipId = current ? await skipIdOf(current.endpoint) : null;
  if (!current || Notification.permission !== "granted") return false;
  return Boolean(await (await caches.open(PUSH_CACHE)).match(recordAddress(key)));
};

/** Asks the browser (it shows its own prompt), then the namespace's server. */
export const follow = async ({ key, basePath, url, title, publicKey }) => {
  if ((await Notification.requestPermission()) !== "granted") {
    throw new Error(
      "Notifications are blocked for this site: allow them in the browser's settings.",
    );
  }
  const pushManager = (await registration()).pushManager;
  const serverKey = fromBase64Url(publicKey);
  let current = await pushManager.getSubscription();
  // Made for another server key (the server's changed): made again.
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

/** Stops `key`'s notifications; following nothing, the subscription goes too. */
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
