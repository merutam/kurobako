// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Share links: a token stands for one item of one namespace. Finding the item
// a token points at, and forgetting tokens whose item is gone.
import { type NamespaceRef, SHARE_TOKEN_PATTERN, type StoredItem } from "../core/model";
import type { AccessEvent } from "../core/visits";
import type { Deps } from "./deps";

/**
 * A token always points at the same item, so this instance remembers where
 * for a minute: reloading a shared page or loading its image skips the hub.
 * Whether the item still exists is always the namespace's answer.
 */
const SHARE_CACHE_MS = 60_000;
const SHARE_CACHE_MAX = 1_000;

export type Share = { token: string; ref: NamespaceRef; itemId: string };

export const createShares = ({ hub, namespace }: Pick<Deps, "hub" | "namespace">) => {
  const cache = new Map<string, { expires: number; ref: NamespaceRef; itemId: string }>();

  /** Where a token points, or null when it is malformed or unknown. */
  const resolve = async (token: string): Promise<Share | null> => {
    if (!SHARE_TOKEN_PATTERN.test(token)) return null;
    const cached = cache.get(token);
    if (cached && cached.expires > Date.now()) {
      return { token, ref: cached.ref, itemId: cached.itemId };
    }
    const share = (await hub().resolveShare(token)) as {
      ref: NamespaceRef;
      itemId: string;
    } | null;
    if (!share) return null;
    if (cache.size >= SHARE_CACHE_MAX) cache.clear();
    cache.set(token, { expires: Date.now() + SHARE_CACHE_MS, ...share });
    return { token, ...share };
  };

  /** Drops a token whose item is gone; the hub's part can finish after the response. */
  const forget = (token: string) => {
    cache.delete(token);
    return hub().forgetShare(token);
  };

  /**
   * The shared item, or null when there is none (`stale` then says whether
   * the token pointed at an item that is gone). Reading it consumes nothing.
   */
  const peek = async (token: string, visitor: AccessEvent) => {
    const share = await resolve(token);
    if (!share) return { item: null, stale: false };
    const item = (await namespace(share.ref).peek(share.itemId, visitor)) as StoredItem | null;
    return { item, stale: !item };
  };

  return { resolve, forget, peek };
};
