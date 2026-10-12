// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A blob: address opened in a tab runs in this site's origin, outside the
// contents sandbox, with a type the sender chose. So blob: only carries inert
// types, and an SVG (which can hold scripts) goes as data:, which has no origin.

export const SVG_TYPE = "image/svg+xml";

/** As the server tells them by their bytes, so both show the same as images. */
const RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
]);

export const isShownImage = (type) => RASTER_TYPES.has(type) || type === SVG_TYPE;

const isInert = (type) =>
  RASTER_TYPES.has(type) || /^(video|audio)\//.test(type) || /^text\/plain(;|$)/.test(type);

export const objectAddress = (blob) =>
  URL.createObjectURL(
    isInert(blob.type) ? blob : blob.slice(0, blob.size, "application/octet-stream"),
  );

export const svgAddress = (bytes) => {
  let binary = "";
  // In parts: spreading a large array into one call overflows the stack.
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:${SVG_TYPE};base64,${btoa(binary)}`;
};

export const imageAddress = async (blob) =>
  blob.type === SVG_TYPE
    ? svgAddress(new Uint8Array(await blob.arrayBuffer()))
    : objectAddress(blob);
