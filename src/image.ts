// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

export type AcceptedImage = {
  extension: "png" | "jpg" | "gif" | "webp" | "avif" | "heic";
  mime: string;
};

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** detectImage never looks past this many bytes. */
export const IMAGE_SIGNATURE_BYTES = 12;

export const detectImage = (bytes: Uint8Array): AcceptedImage | null => {
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
    return { mime: "image/png", extension: "png" };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }

  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    return { mime: "image/gif", extension: "gif" };
  }

  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { mime: "image/webp", extension: "webp" };
  }

  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") {
      return { mime: "image/avif", extension: "avif" };
    }

    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return { mime: "image/heic", extension: "heic" };
    }
  }

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

const safeBaseName = (value: string): string => {
  const lastSegment = value.split(/[\\/]/).at(-1) || "image";
  return safeBase(lastSegment.replace(/\.[^.]+$/, ""), "image");
};

export const safeImageName = (value: string, extension: string): string =>
  `${safeBaseName(value)}.${extension}`;

/** Keeps the original extension when it is short and alphanumeric. */
export const safeFileName = (value: string): string => {
  const lastSegment = value.split(/[\\/]/).at(-1) || "file";
  const extension = /\.([\p{L}\p{N}]{1,10})$/u.exec(lastSegment)?.[1];
  const base = safeBase(lastSegment.replace(/\.[^.]+$/, ""), "file");
  return extension ? `${base}.${extension}` : base;
};
