// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// MAX_STORAGE_BYTES: the most every item together may take.
import type { AppConfig } from "../config";
import type { HubApi } from "../core/hub";

/**
 * Why `bytes` more do not fit, or null when they do. Without a limit,
 * nothing is asked of the hub.
 */
export const storageRefusal = async (
  config: Pick<AppConfig, "maxStorageBytes">,
  hub: () => Pick<HubApi, "storedBytes">,
  bytes: number,
) => {
  const limit = config.maxStorageBytes;
  if (limit === null) return null;
  if ((await hub().storedBytes()) + bytes <= limit) return null;
  return `This Kurobako is full: it keeps at most ${limit} bytes. Delete some items, or wait for them to expire.`;
};
