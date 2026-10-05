// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
import type { PlatformLimits } from "../config";

/**
 * A self-hosted server has no request limit of its own; these keep sizes
 * sensible. Files stream to storage, so they can be large. Texts stay small,
 * since the queue's JSON carries them whole.
 */
export const BUN_LIMITS: PlatformLimits = {
  maxFileBytes: 10_000_000_000,
  maxTextBytes: 16_000_000,
};
