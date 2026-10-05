// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Helpers shared by the namespace page and the shared-item page.

export const element = (selector) => {
  const found = document.querySelector(selector);
  if (!found) throw new Error("Something went wrong. Reload the page.");
  return found;
};

/** The public config the server embeds in each page (no request needed). */
export const readConfig = () => JSON.parse(element("#config").textContent);

export const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});
const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });

/** Decimal units, like the limits they show (100 MB, 256 kB). */
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

export const request = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Server error (${response.status}).`);
  }
  return response;
};

export const compactText = (text) => text.replace(/\s+/g, " ").trim() || "(blank)";

/** Burn-after-reading texts never show a preview: that would be a read. */
export const HIDDEN_TITLE = "Hidden until opened";

export const button = (label, onClick, className) => {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  if (className) control.className = className;
  control.addEventListener("click", onClick);
  return control;
};

export const copyText = async (text) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.className = "clipboard-fallback";
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) throw new Error("The browser blocked clipboard access.");
};

export const asPng = async (blob) => {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(new Error("The image could not be converted."))),
      "image/png",
    );
  });
};
