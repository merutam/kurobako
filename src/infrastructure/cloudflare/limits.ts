// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
import type { PlatformLimits } from "../../config";

/**
 * Request bodies cap at 100 MB on Free and Pro; Durable Object SQLite values at
 * 2 MB. An inline text is stored inside its item's JSON, where escaping can
 * grow a byte to six (\u00XX), plus the other fields: the threshold keeps the
 * worst case under the cap. Longer texts go to R2 as before.
 */
export const CLOUDFLARE_LIMITS: PlatformLimits = {
  maxFileBytes: 100_000_000,
  maxTextBytes: 100_000_000,
  maxInlineTextBytes: 300_000,
};
