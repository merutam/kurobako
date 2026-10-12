// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// So a busy home page asks the hub once per STATS_TTL_MS.
import type { Deps } from "./deps";

export const STATS_TTL_MS = 30_000;

export const createStats = ({ hub }: Pick<Deps, "hub">) => {
  let cache: { expires: number; body: Promise<Record<string, unknown>> } | null = null;

  const current = () => {
    if (!cache || cache.expires < Date.now()) {
      const entry = {
        expires: Date.now() + STATS_TTL_MS,
        // An RPC result must not outlive its request.
        body: hub()
          .stats()
          .then((stats) => ({ ...stats })),
      };
      cache = entry;
      // A failed read must not be served from the cache.
      entry.body.catch(() => {
        if (cache === entry) cache = null;
      });
    }
    return cache.body;
  };

  return { current };
};
