// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

/**
 * A file the browser can show: an image, or a video it may play. Anything
 * else is a plain download.
 */
export type AcceptedMedia = {
  kind: "image" | "video";
  extension: "png" | "jpg" | "gif" | "webp" | "avif" | "heic" | "mp4" | "mov" | "webm" | "mkv";
  mime: string;
};

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** detectMedia never looks past this many bytes. */
export const SIGNATURE_BYTES = 64;

/** MP4 brands (an ISO media file's first "ftyp") that hold video. */
const MP4_BRANDS = [
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "mmp4",
  "dash",
];

/**
 * A Matroska file's DocType ("webm" or "matroska"), from its EBML header at
 * the start: the element 0x4282, a one-byte size, then the name.
 */
const ebmlDocType = (bytes: Uint8Array): string | null => {
  if (bytes.length < 4 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf) return null;
  if (bytes[3] !== 0xa3) return null;
  for (let index = 4; index + 2 < Math.min(bytes.length, SIGNATURE_BYTES); index += 1) {
    if (bytes[index] !== 0x42 || bytes[index + 1] !== 0x82) continue;
    const size = bytes[index + 2] ?? 0;
    if (!(size & 0x80)) return null;
    return ascii(bytes, index + 3, size & 0x7f);
  }
  return null;
};

const image = (extension: AcceptedMedia["extension"], mime: string): AcceptedMedia => ({
  kind: "image",
  extension,
  mime,
});
const video = (extension: AcceptedMedia["extension"], mime: string): AcceptedMedia => ({
  kind: "video",
  extension,
  mime,
});

/** What a file is, from its first SIGNATURE_BYTES bytes; never from its name. */
export const detectMedia = (bytes: Uint8Array): AcceptedMedia | null => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return image("png", "image/png");
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return image("jpg", "image/jpeg");
  }

  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    return image("gif", "image/gif");
  }

  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return image("webp", "image/webp");
  }

  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") {
      return image("avif", "image/avif");
    }

    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return image("heic", "image/heic");
    }

    if (brand === "qt  ") return video("mov", "video/quicktime");
    if (MP4_BRANDS.includes(brand)) return video("mp4", "video/mp4");
  }

  const docType = ebmlDocType(bytes);
  if (docType === "webm") return video("webm", "video/webm");
  if (docType === "matroska") return video("mkv", "video/x-matroska");

  return null;
};

const cleanName = (value: string): string =>
  value
    .normalize("NFKC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim();

/** Names Windows refuses for a file, whatever the extension. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A file name's base, safe on every system: no reserved name, and no leading
 * "-" that a shell command would read as an option.
 */
const safeBase = (value: string, fallback: string): string => {
  const base = cleanName(value).slice(0, 100);
  if (!base) return fallback;
  return WINDOWS_RESERVED.test(base) || base.startsWith("-") ? `_${base}` : base;
};

const safeBaseName = (value: string, fallback: string): string => {
  const lastSegment = value.split(/[\\/]/).at(-1) || fallback;
  return safeBase(lastSegment.replace(/\.[^.]+$/, ""), fallback);
};

/** An image's or video's name, always with the extension of what it is. */
export const safeMediaName = (value: string, extension: string, fallback = "image"): string =>
  `${safeBaseName(value, fallback)}.${extension}`;

/** Keeps the original extension when it is short and alphanumeric. */
export const safeFileName = (value: string): string => {
  const lastSegment = value.split(/[\\/]/).at(-1) || "file";
  const extension = /\.([\p{L}\p{N}]{1,10})$/u.exec(lastSegment)?.[1];
  const base = safeBase(lastSegment.replace(/\.[^.]+$/, ""), "file");
  return extension ? `${base}.${extension}` : base;
};
