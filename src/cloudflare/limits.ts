// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
import type { PlatformLimits } from "../config";

/**
 * Cloudflare's own limits: a request body of 100 MB on the Free and Pro plans
 * (more on Business and Enterprise), and 2 MB per value in a Durable Object's
 * SQLite, where a text is kept with its details, hence 1 MB.
 */
export const CLOUDFLARE_LIMITS: PlatformLimits = {
  maxFileBytes: 100_000_000,
  maxTextBytes: 1_000_000,
};
