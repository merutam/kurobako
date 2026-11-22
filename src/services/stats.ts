// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// So a busy home page asks the hub once per STATS_TTL_MS.
import type { Deps } from "./deps";

export const STATS_TTL_MS = 30_000;

export const createStats = ({ hub }: Pick<Deps, "hub">) => {
  // The figures, never the promise that reads them: on Cloudflare a request
  // may not await a promise another, finished request created
  // (handle_cross_request_promise_resolution). Requests that arrive while a
  // read is in flight read too; a failed read is not cached.
  let cache: { expires: number; body: Record<string, unknown> } | null = null;

  const current = async () => {
    if (cache && cache.expires >= Date.now()) return cache.body;
    // A plain copy: an RPC result must not outlive its request.
    const body = { ...(await hub().stats()) };
    cache = { expires: Date.now() + STATS_TTL_MS, body };
    return body;
  };

  return { current };
};
