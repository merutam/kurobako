// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Texts and files to one bundle, and back, for the composer (see protocol/bundle.js).
import {
  ASSETS,
  BUNDLE_MIME,
  readBundle,
  uniqueNames,
  writeBundle,
} from "../../../../protocol/bundle.js";
import { formatBytes } from "../../lib/common.js";
import { isMarkdown } from "../../lib/markdown.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** So the text reads right in any Markdown viewer once extracted. */
export const withAssetPaths = (text, files) => {
  const names = new Set(files.map((file) => file.name));
  return text.replace(/(!?\[[^\]\n]*\]\(\s*)(<?)([^)\s>]+)/g, (whole, start, open, target) => {
    let name = target;
    try {
      name = decodeURIComponent(target.replace(/^\.\//, ""));
    } catch {
      return whole;
    }
    return names.has(name) ? `${start}${open}${ASSETS}${target.replace(/^\.\//, "")}` : whole;
  });
};

/** `texts`: [{ name, text }], the first one the bundle's main text. */
export const buildBundle = async ({ texts, files, limit }) => {
  const names = uniqueNames(texts.map((text) => text.name));
  const entries = [
    ...texts.map(({ text }, index) => ({
      path: names[index],
      type: isMarkdown(names[index]) ? "text/markdown" : "text/plain",
      text: true,
      bytes: encoder.encode(isMarkdown(names[index]) ? withAssetPaths(text, files) : text),
    })),
    ...(await Promise.all(
      files.map(async (file) => ({
        path: `${ASSETS}${file.name}`,
        type: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    )),
  ];
  const bytes = writeBundle({ main: names[0], entries });
  if (bytes.length > limit) {
    throw new Error(
      `The bundle is too large: ${formatBytes(bytes.length)}, max ${formatBytes(limit)}.`,
    );
  }
  const name = `${names[0].replace(/\.[^.]+$/, "")}.tar`;
  return new File([bytes], name, { type: BUNDLE_MIME });
};

/** Its texts, main first, and its files under their own names. */
export const openBundle = (bytes) => {
  const bundle = readBundle(bytes);
  const texts = bundle.entries.filter((part) => part.text);
  texts.sort((a, b) => Number(b.path === bundle.main) - Number(a.path === bundle.main));
  return {
    texts: texts.map((part) => ({ path: part.path, text: decoder.decode(part.bytes) })),
    files: bundle.entries
      .filter((part) => !part.text)
      .map((part) => {
        const name = part.path.startsWith(ASSETS) ? part.path.slice(ASSETS.length) : part.path;
        return new File([part.bytes], name, { type: part.type });
      }),
  };
};
