// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
import type { PlatformLimits } from "../config";

/**
 * Cloudflare's own limits: a request body of 100 MB on the Free and Pro plans
 * (more on Business and Enterprise), and 2 MB per value in a Durable Object's
 * SQLite. Larger texts live in object storage, so only the inline threshold
 * needs to stay below the SQLite value limit.
 */
export const CLOUDFLARE_LIMITS: PlatformLimits = {
  maxFileBytes: 100_000_000,
  maxTextBytes: 100_000_000,
  maxInlineTextBytes: 2_000_000,
};
