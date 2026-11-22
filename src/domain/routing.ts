// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Each namespace belongs to one of SLOT_COUNT slots, and each slot to one
// server, which keeps everything about it. A share token starts with its slot,
// so a link reaches the right server without asking anyone.

import { type NamespaceRef, objectName, plainName, SHARE_TOKEN_PATTERN, sealedName } from "./model";

/** Fixed, whatever the base path, so clients can find any server. */
export const WELL_KNOWN_PATH = "/.well-known/kurobako";
export const PROTOCOL_PATH = "/k/protocol";
export const LICENSES_PATH = "/k/licenses";
/** A client of another version cannot open this server's encrypted items (k.mjs: PROTOCOL). */
export const PROTOCOL_VERSION = 8;
/** Under /k: the server's own, not part of the protocol. */
export const ADMIN_PATH = "/k/a";
export const CLIENT_PATH = "/k.mjs";

/** The well-known description is answered at the domain's root too. */
export const sitePath = (base: string, pathname: string): string | null => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (!base) return path;
  if (path === base || path.startsWith(`${base}/`)) return path.slice(base.length) || "/";
  return path === WELL_KNOWN_PATH ? path : null;
};

export const SLOT_COUNT = 4096;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Small and well mixed, so a router in any language can compute the same. */
const hash32 = (text: string) => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

export const slotOfKey = (key: string) => hash32(key) % SLOT_COUNT;

export const slotOf = (ref: NamespaceRef) => slotOfKey(objectName(ref));

/** Two base64url characters (64 × 64 = SLOT_COUNT). */
export const slotPrefix = (slot: number) => `${BASE64URL[slot >> 6]}${BASE64URL[slot & 63]}`;

export const tokenSlot = (token: string): number =>
  BASE64URL.indexOf(token[0] ?? "") * 64 + BASE64URL.indexOf(token[1] ?? "");

/** Null when any server can answer it. */
export const routeOf = (pathname: string): number | null => {
  const [first = "", second = ""] = pathname.split("/").slice(1);
  if (first === "e") {
    const name = sealedName(second);
    return name ? slotOf({ space: "sealed", name }) : null;
  }
  if (first === "i" || first === "v") {
    const token = /^[A-Za-z0-9_-]+/.exec(second)?.[0] ?? "";
    return SHARE_TOKEN_PATTERN.test(token) ? tokenSlot(token) : null;
  }
  const name = plainName(decodeURIComponent(first));
  return name ? slotOf({ space: "plain", name }) : null;
};

/** Rendezvous hashing: adding a server moves only about 1/n of the slots. */
export const slotOwners = (servers: string[]): string[] =>
  Array.from({ length: SLOT_COUNT }, (_, slot) => {
    let best = servers[0] ?? "";
    let bestScore = -1;
    for (const server of servers) {
      const score = hash32(`${slot}@${server}`);
      if (score > bestScore) {
        best = server;
        bestScore = score;
      }
    }
    return best;
  });
