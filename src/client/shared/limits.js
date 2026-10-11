// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The instance's limits as the namespace page writes them: the server renders
// them (src/pages/namespace.tsx) and the browser checks sends against the
// same numbers, so neither writes them differently from the other.
import { formatBytes, formatDuration } from "./format.js";

/** Lifetimes a send may pick, up to the instance's own (or 30 days without one). */
const EXPIRY_PRESETS = [
  60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400, 259_200, 604_800, 2_592_000,
];
const LONGEST_EXPIRY = 30 * 24 * 60 * 60;

/** "Expires after 1 day", from itemTtlSeconds. */
export const expiryLabel = (ttlSeconds) =>
  ttlSeconds ? `Expires after ${formatDuration(ttlSeconds)}` : "No expiration";

/** The expiry picker's options, as [label, value]; "" is the instance default. */
export const expiryOptions = (ttlSeconds) => [
  [
    ttlSeconds
      ? `Instance default (${formatDuration(ttlSeconds)})`
      : "Instance default (no expiration)",
    "",
  ],
  ...EXPIRY_PRESETS.filter((seconds) => seconds <= (ttlSeconds || LONGEST_EXPIRY)).map(
    (seconds) => [formatDuration(seconds), String(seconds)],
  ),
];

/** How many files one send takes: no more than the queue holds or a minute allows. */
export const maxFilesAtOnce = ({ maxItems, sendsPerMinute }) =>
  Math.min(maxItems ?? 20, sendsPerMinute ?? 20);

/**
 * The largest file an encrypted namespace takes: sealing adds a 16-byte tag
 * per 65,536-byte segment, and the server's limit is on what it receives
 * (k.mjs's contentSize, which a test checks this against).
 */
export const sealedFileLimit = (maxFileBytes) =>
  Math.max(0, maxFileBytes - 16 * Math.ceil(maxFileBytes / 65_552));

/** Under the file field: "Any files, up to 20 at once · max 100 MB each". */
export const fileLimitText = (count, bytes) =>
  count > 1
    ? `Any files, up to ${count} at once · max ${formatBytes(bytes)} each`
    : `Any file · max ${formatBytes(bytes)}`;

/** Under the text: its size against the limit. */
export const textSizeText = (bytes, maxBytes, paused = false) =>
  `${formatBytes(bytes)} / ${formatBytes(maxBytes)}${paused ? " · no colors" : ""}`;

/** What a backup holds, plain or encrypted. */
export const backupHint = (encrypted) =>
  encrypted
    ? "Every item as a zip or a tar, still encrypted. Items that delete when opened are left out."
    : "Every item as a zip or a tar. Items that delete when opened are left out.";
