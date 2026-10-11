// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Web Push: telling a device that something arrived, through its browser's
// push service, with no connection kept open. The message is encrypted for
// the device (RFC 8291), so the push service reads nothing of it, and signed
// with the server's VAPID key (RFC 8292). WebCrypto only: the same on Bun and
// on Workers.

export type PushConfig = {
  /** The VAPID public key: a P-256 point, uncompressed, base64url (65 bytes). */
  publicKey: string;
  /** Its private scalar, base64url (32 bytes). */
  privateKey: string;
  /** Who runs this server, for the push services: a mailto: or https: URL. */
  subject: string;
};

/** A browser's subscription, as PushSubscription.toJSON() gives it. */
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** What a device is told: which namespace, which item, and a glimpse of it. */
export type PushMessage = {
  space: "plain" | "sealed";
  name: string;
  id: string;
  kind: string;
  /** A plain text's start or a file's name; none for what is encrypted or read once. */
  preview?: string;
};

export const PUSH_SCHEMA = `CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  skip_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

/** Devices told of each namespace's sends; past it, the oldest goes. */
export const MAX_PUSH_SUBSCRIPTIONS = 20;
/** A preview's length, well within a push message's 4 kB. */
export const PUSH_PREVIEW_CHARS = 140;

/**
 * Where subscriptions may point: the browsers' push services. Anything else
 * would have this server post wherever a client asks.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(?:^|\.)push\.apple\.com$/,
  /(?:^|\.)notify\.windows\.com$/,
];

const encoder = new TextEncoder();

export const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** Bytes WebCrypto takes: backed by a plain ArrayBuffer. */
type Bytes = Uint8Array<ArrayBuffer>;

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const decodes = (text: unknown, length: number) => {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) return false;
  try {
    return fromBase64Url(text).length === length;
  } catch {
    return false;
  }
};

/**
 * Which subscription a send comes from, so its own device is not told of it:
 * the first 128 bits of SHA-256(endpoint), base64url (the page sends it as
 * Push-Skip; lib/push.js computes the same).
 */
export const skipIdOf = async (endpoint: string) =>
  toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(endpoint))).slice(0, 16),
  );

/** A subscription from a client, checked; or why not. */
export const parseTarget = (value: unknown): PushTarget | { error: string } => {
  const subscription = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  let url: URL;
  try {
    url = new URL(String(subscription?.endpoint));
  } catch {
    return { error: "A subscription needs its endpoint." };
  }
  if (url.protocol !== "https:" || !PUSH_HOSTS.some((host) => host.test(url.hostname))) {
    return { error: "That endpoint is not a browser's push service." };
  }
  const { p256dh, auth } = subscription.keys ?? {};
  // An uncompressed P-256 point, and a 16-byte secret.
  if (!decodes(p256dh, 65) || fromBase64Url(p256dh as string)[0] !== 4 || !decodes(auth, 16)) {
    return { error: "A subscription needs its keys (p256dh and auth)." };
  }
  return { endpoint: url.href, p256dh: p256dh as string, auth: auth as string };
};

/**
 * What is wrong with a VAPID key pair, if anything (ops/vapid.ts makes a
 * good one): which key, and what it should look like. Never the keys.
 */
export const vapidKeyProblem = (publicKey: string, privateKey: string): string | null => {
  if (!publicKey || !privateKey) {
    return `${publicKey ? "VAPID_PRIVATE_KEY" : "VAPID_PUBLIC_KEY"} is missing: notifications need both keys.`;
  }
  if (!decodes(publicKey, 65) || fromBase64Url(publicKey)[0] !== 4) {
    return `VAPID_PUBLIC_KEY is not a VAPID public key (87 base64url characters, starting with B; it has ${publicKey.length}).`;
  }
  if (!decodes(privateKey, 32)) {
    return `VAPID_PRIVATE_KEY is not a VAPID private key (43 base64url characters; it has ${privateKey.length}).`;
  }
  return null;
};

const hkdf = async (salt: Bytes, ikm: Bytes, info: Bytes, length: number) =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
      length * 8,
    ),
  );

/** One record holds the whole message: this much, its padding and tag included. */
const RECORD_SIZE = 4096;

/**
 * A message encrypted for one subscription (RFC 8291, aes128gcm): only the
 * browser holding the subscription's private key opens it. `salt` and
 * `serverKeys` are for tests; each message gets fresh ones.
 */
export const encryptMessage = async (
  target: PushTarget,
  plaintext: Uint8Array,
  salt: Bytes = crypto.getRandomValues(new Uint8Array(16)),
  serverKeys?: CryptoKeyPair,
) => {
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error("Push message too long.");
  const uaPublic = fromBase64Url(target.p256dh);
  const keys =
    serverKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer,
  );
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      // As the standard names it; the Workers types call it $public.
      { name: "ECDH", public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0],
      keys.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    fromBase64Url(target.auth),
    shared,
    concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic),
    32,
  );
  const contentKey = await hkdf(
    salt,
    ikm,
    concat(encoder.encode("Content-Encoding: aes128gcm\0")),
    16,
  );
  const nonce = await hkdf(salt, ikm, concat(encoder.encode("Content-Encoding: nonce\0")), 12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]),
      // 2: the last (and only) record, with no padding.
      concat(plaintext, Uint8Array.of(2)),
    ),
  );
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
};

/**
 * The Authorization header that names this server to a push service (RFC
 * 8292): a JWT for the endpoint's origin, signed with the VAPID key, good
 * for twelve hours.
 */
export const vapidAuthorization = async (
  endpoint: string,
  config: PushConfig,
  now = Date.now(),
) => {
  const json = (value: unknown) => toBase64Url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${json({ typ: "JWT", alg: "ES256" })}.${json({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: config.subject,
  })}`;
  const point = fromBase64Url(config.publicKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: config.privateKey,
      x: toBase64Url(point.slice(1, 33)),
      y: toBase64Url(point.slice(33, 65)),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto signs as JWS wants it: r and s, 32 bytes each.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${config.publicKey}`;
};

/**
 * Sends one message: "gone" when the push service no longer knows the
 * subscription (the browser dropped it), so it can be forgotten.
 */
export const sendPush = async (
  target: PushTarget,
  message: PushMessage,
  config: PushConfig,
): Promise<"sent" | "gone" | "failed"> => {
  const response = await fetch(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(target.endpoint, config),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      // Kept a day for a device that is offline, as long as an item lasts by default.
      TTL: String(24 * 60 * 60),
      // A clipboard is wanted now: delivered even to a device saving power.
      Urgency: "high",
    },
    body: await encryptMessage(target, encoder.encode(JSON.stringify(message))),
  });
  await response.body?.cancel();
  if (response.status === 404 || response.status === 410) return "gone";
  return response.ok ? "sent" : "failed";
};
