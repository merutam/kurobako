// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Server and browser use the same numbers and words, so they never disagree.
import { formatBytes, formatDuration } from "./format.js";

const EXPIRY_PRESETS = [
  60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400, 259_200, 604_800, 2_592_000,
];
const LONGEST_EXPIRY = 30 * 24 * 60 * 60;

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

export const maxFilesAtOnce = ({ maxItems, sendsPerMinute }) =>
  Math.min(maxItems ?? 20, sendsPerMinute ?? 20);

/** Sealing adds a 16-byte tag per 64 KiB, and the server limits what it receives. */
export const sealedFileLimit = (maxFileBytes) =>
  Math.max(0, maxFileBytes - 16 * Math.ceil(maxFileBytes / 65_552));

export const fileLimitText = (count, bytes) =>
  count > 1
    ? `Any files, up to ${count} at once · max ${formatBytes(bytes)} each`
    : `Any file · max ${formatBytes(bytes)}`;

export const textSizeText = (bytes, maxBytes, paused = false) =>
  `${formatBytes(bytes)} / ${formatBytes(maxBytes)}${paused ? " · no colors" : ""}`;

export const backupHint = (encrypted) =>
  encrypted
    ? "Every item as a zip or a tar, still encrypted. Items that delete when opened are left out."
    : "Every item as a zip or a tar. Items that delete when opened are left out.";
