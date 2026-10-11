// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Makes a VAPID key pair for push notifications (see src/core/push.ts):
//   bun ops/vapid.ts >> .env           (Bun server, compose)
//   bunx wrangler secret put VAPID_PRIVATE_KEY   (Cloudflare; the public key can be a var)
// Keep the pair: a new one makes every browser subscribe again.
export {};

const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${d}`);
