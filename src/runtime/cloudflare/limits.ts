// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
import type { PlatformLimits } from "../../config";

/**
 * Request bodies cap at 100 MB on Free and Pro; Durable Object SQLite values at
 * 2 MB, so only the inline text threshold must stay below it.
 */
export const CLOUDFLARE_LIMITS: PlatformLimits = {
  maxFileBytes: 100_000_000,
  maxTextBytes: 100_000_000,
  maxInlineTextBytes: 2_000_000,
};
