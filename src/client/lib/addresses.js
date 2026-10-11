// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Addresses for contents a page holds. A blob: address opened in a tab is a
// document of this site's own origin, outside the sandbox the server and the
// Service Worker serve contents in; and types come from whoever sent the item
// (an encrypted item's metadata, a bundle's manifest). So a blob: address only
// ever carries a type that is no document; an SVG, which can hold scripts, is
// shown from a data: address instead, whose origin is no one's.

export const SVG_TYPE = "image/svg+xml";

/** The images the server shows as images, told by their bytes. */
const RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
]);

/** Whether a type is shown as an image: what the server types as one. */
export const isShownImage = (type) => RASTER_TYPES.has(type) || type === SVG_TYPE;

/** Types a browser never runs as a document. */
const isInert = (type) =>
  RASTER_TYPES.has(type) || /^(video|audio)\//.test(type) || /^text\/plain(;|$)/.test(type);

/** A blob: address for `blob`, as a download unless its type is inert. */
export const objectAddress = (blob) =>
  URL.createObjectURL(
    isInert(blob.type) ? blob : blob.slice(0, blob.size, "application/octet-stream"),
  );

/** An SVG's bytes as a data: address, for an <img>. */
export const svgAddress = (bytes) => {
  let binary = "";
  // In parts: spreading a large array into one call overflows the stack.
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:${SVG_TYPE};base64,${btoa(binary)}`;
};

/** An image's address: data: for an SVG, blob: for any other. */
export const imageAddress = async (blob) =>
  blob.type === SVG_TYPE
    ? svgAddress(new Uint8Array(await blob.arrayBuffer()))
    : objectAddress(blob);
