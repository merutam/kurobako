// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Numbers, sizes, times and titles as the pages write them. Nothing here
// touches a page, so the server renders with the same functions.

export const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});
const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
/** Counts as the visitor's language writes them (1,234). */
export const numberFormatter = new Intl.NumberFormat();

/** Decimal units, like the limits they show (100 MB, 64 kB). */
export const formatBytes = (bytes) => {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${Number(value.toFixed(value < 10 ? 1 : 0))} ${units[unit]}`;
};

export const formatDuration = (seconds) => {
  const units = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  const [unit, size] = units.find(([, size]) => seconds >= size) ?? units.at(-1);
  const value = Math.round(seconds / size);
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
};

/** How long ago, in a few characters: "now", "5 min", "3 h", "2 d". */
export const formatAge = (date) => {
  const minutes = Math.floor((Date.now() - Date.parse(date)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
};

export const formatExpiry = (expiresAt) => {
  const remainingMs = Date.parse(expiresAt) - Date.now();
  if (remainingMs <= 0) return "expired";
  const units = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
  ];
  const match = units.find(([, size]) => remainingMs >= size);
  if (match)
    return `expires ${relativeFormatter.format(Math.floor(remainingMs / match[1]), match[0])}`;
  return `expires ${relativeFormatter.format(Math.ceil(remainingMs / 60_000), "minute")}`;
};

export const compactText = (text) => text.replace(/\s+/g, " ").trim() || "(blank)";

/** Burn-after-reading texts never show a preview: that would be a read. */
export const HIDDEN_TITLE = "Hidden until opened";
