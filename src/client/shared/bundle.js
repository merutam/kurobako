// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A bundle: texts and files sent together as one item, so a Markdown text
// can show the images beside it. It is a plain tar (ustar), which any tool
// opens, whose first entry is kurobako.json, the manifest:
//
//   {"kurobako": "bundle", "version": 1, "main": "notes.md",
//    "entries": [{"path": "notes.md", "type": "text/markdown", "text": true},
//                {"path": "assets/photo.png", "type": "image/png"}]}
//
// The entries follow in that order: texts at the root, as the tabs a page
// shows, `main` first; files under assets/, where the texts refer to them
// (![](assets/photo.png)), as any Markdown viewer reads them once extracted. The server and k.mjs tell a bundle by its first bytes, the manifest's
// name (see isBundle), and type it BUNDLE_MIME. Nothing here touches a page.

export const BUNDLE_MIME = "application/vnd.kurobako.bundle+tar";
/** Where a bundle keeps its files, apart from its texts. */
export const ASSETS = "assets/";
const MANIFEST_NAME = "kurobako.json";
const BLOCK = 512;
/** ustar names hold 100 bytes; bundle paths stay within them. */
const MAX_PATH_BYTES = 100;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Whether these first bytes start a bundle: a tar whose first entry is the manifest. */
export const isBundle = (bytes) => {
  const signature = encoder.encode(`${MANIFEST_NAME}\0`);
  return (
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)
  );
};

const octal = (value, width) => `${value.toString(8).padStart(width - 1, "0")}\0`;

const header = (path, size, mtime) => {
  const block = new Uint8Array(BLOCK);
  const put = (offset, text) => block.set(encoder.encode(text), offset);
  const name = encoder.encode(path);
  if (name.length > MAX_PATH_BYTES) throw new Error(`Name too long for a bundle: ${path}`);
  block.set(name, 0);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, octal(size, 12));
  put(136, octal(mtime, 12));
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
};

/**
 * The bundle's bytes, from its texts and files: `entries` are
 * { path, type, bytes, text? } in the order a page shows them; `main` names
 * the text shown first. Every entry is dated `mtime` (seconds), the send's.
 */
export const writeBundle = ({ main, entries, mtime = Math.floor(Date.now() / 1000) }) => {
  const manifest = encoder.encode(
    JSON.stringify({
      kurobako: "bundle",
      version: 1,
      main,
      entries: entries.map(({ path, type, text }) => ({ path, type, ...(text ? { text } : {}) })),
    }),
  );
  const parts = [];
  for (const [path, bytes] of [
    [MANIFEST_NAME, manifest],
    ...entries.map((entry) => [entry.path, entry.bytes]),
  ]) {
    parts.push(header(path, bytes.length, mtime), bytes);
    const padding = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (padding) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const field = (block, offset, length) => {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
};

/**
 * A bundle's manifest and entries ({ path, type, text, bytes }, in the
 * manifest's order), from its bytes. Throws if it is not one.
 */
export const readBundle = (bytes) => {
  const files = new Map();
  for (let offset = 0; offset + BLOCK <= bytes.length; ) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);
    const size = Number.parseInt(field(block, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(block[156]);
    const start = offset + BLOCK;
    if (!Number.isSafeInteger(size) || start + size > bytes.length) {
      throw new Error("This bundle is cut short.");
    }
    if (type === "0" || type === "\0") {
      files.set(prefix ? `${prefix}/${name}` : name, bytes.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  const manifestBytes = files.get(MANIFEST_NAME);
  if (!manifestBytes) throw new Error("This is not a bundle: it has no kurobako.json.");
  const manifest = JSON.parse(decoder.decode(manifestBytes));
  if (manifest?.kurobako !== "bundle" || !Array.isArray(manifest.entries)) {
    throw new Error("This is not a bundle: its kurobako.json is not a bundle's.");
  }
  const entries = manifest.entries
    .filter((entry) => typeof entry?.path === "string" && files.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      type: typeof entry.type === "string" ? entry.type : "application/octet-stream",
      text: entry.text === true,
      bytes: files.get(entry.path),
    }));
  const main = entries.find((entry) => entry.text && entry.path === manifest.main)
    ? manifest.main
    : entries.find((entry) => entry.text)?.path;
  return { version: manifest.version, main, entries };
};

/**
 * Names unique within a bundle: a second "photo.png" becomes "photo-2.png".
 * Takes a list of wanted names, returns the names to use, in order.
 */
export const uniqueNames = (names) => {
  const taken = new Set([MANIFEST_NAME]);
  return names.map((wanted) => {
    const dot = wanted.lastIndexOf(".");
    const base = dot > 0 ? wanted.slice(0, dot) : wanted;
    const extension = dot > 0 ? wanted.slice(dot) : "";
    let name = wanted;
    for (let count = 2; taken.has(name); count += 1) name = `${base}-${count}${extension}`;
    taken.add(name);
    return name;
  });
};
