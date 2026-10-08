// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Spreading namespaces over several servers. Each namespace belongs to one of
// SLOT_COUNT slots, from a hash of its name, and each slot to one server,
// which keeps everything about it: its database, live connections, timers and
// share links. A share token starts with its namespace's slot, so a link
// reaches the right server without asking anyone. Anything else (pages,
// config, stats) can be answered by any server.

import { type NamespaceRef, objectName, plainName, SHARE_TOKEN_PATTERN, sealedName } from "./model";

/** Where any Kurobako server describes itself, whatever its base path. */
export const WELL_KNOWN_PATH = "/.well-known/kurobako";
/** The encryption protocol's page, inside the site. */
export const PROTOCOL_PATH = "/k/protocol";
/** The project and bundled third-party licenses, inside the site. */
export const LICENSES_PATH = "/k/licenses";
/**
 * The protocol's version, in /.well-known/kurobako: a client of another one
 * cannot open this server's encrypted items (k.mjs has it too, as PROTOCOL).
 */
export const PROTOCOL_VERSION = 6;
/** The admin dashboard and its API: the server's own, so under /k, not the protocol's. */
export const ADMIN_PATH = "/k/a";
/** The client for encrypted namespaces, served from public/. */
export const CLIENT_PATH = "/k.mjs";

/**
 * A request's path inside the site at `base` ("" for the root, or e.g. "/k"),
 * without a trailing slash; null when it falls outside. The well-known
 * description is answered at the domain's root too.
 */
export const sitePath = (base: string, pathname: string): string | null => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (!base) return path;
  if (path === base || path.startsWith(`${base}/`)) return path.slice(base.length) || "/";
  return path === WELL_KNOWN_PATH ? path : null;
};

export const SLOT_COUNT = 4096;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * 32-bit FNV-1a, then MurmurHash3's final mix so that strings differing in
 * one character land far apart. Small, and a router in any language can
 * compute the same.
 */
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

/** The slot of any text; a namespace's comes from its name and space. */
export const slotOfKey = (key: string) => hash32(key) % SLOT_COUNT;

export const slotOf = (ref: NamespaceRef) => slotOfKey(objectName(ref));

/** Two base64url characters (64 × 64 = SLOT_COUNT), the start of a share token. */
export const slotPrefix = (slot: number) => `${BASE64URL[slot >> 6]}${BASE64URL[slot & 63]}`;

/** The slot a share token (SHARE_TOKEN_PATTERN) was made in: its first two characters. */
export const tokenSlot = (token: string): number =>
  BASE64URL.indexOf(token[0] ?? "") * 64 + BASE64URL.indexOf(token[1] ?? "");

/**
 * The slot a request belongs to, from its path alone: a namespace's
 * (/<name>/…, /e/<id>/…) or a share link's (/i/<token>…). Null when any
 * server can answer it.
 */
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

/**
 * The server for each slot, by rendezvous hashing: each slot goes to the
 * server that scores highest for it. Adding a server moves only the slots it
 * now wins, about 1/n of them, and every router with the same list agrees.
 */
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
