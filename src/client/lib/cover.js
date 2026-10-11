// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// An audio file's cover picture, from its ID3v2 tag (MP3, and some others):
// the APIC frame (PIC in ID3v2.2), preferring the front cover. Only the tag is
// read, from the start of the file; the stream is dropped once it is in.
// Loaded on demand by audioPlayer (items.js).

/** A tag larger than this is not read: covers are much smaller. */
const MAX_TAG_BYTES = 16_000_000;
const FRONT_COVER = 3;

/** ID3's 28-bit sizes: seven bits in each of four bytes. */
const syncsafe = (bytes, at) =>
  (bytes[at] << 21) | (bytes[at + 1] << 14) | (bytes[at + 2] << 7) | bytes[at + 3];

const isTag = (bytes) =>
  bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;

/** Undoes ID3's unsynchronisation: every 0xFF 0x00 was written for a 0xFF. */
const resync = (bytes) => {
  const out = [];
  for (let index = 0; index < bytes.length; index += 1) {
    out.push(bytes[index]);
    if (bytes[index] === 0xff && bytes[index + 1] === 0) index += 1;
  }
  return Uint8Array.from(out);
};

/** Where a frame's picture starts, after its text fields; -1 if malformed. */
const pictureStart = (frame, version) => {
  const encoding = frame[0];
  let at = 1;
  if (version === 2) {
    at += 3; // Image format: "JPG", "PNG".
  } else {
    while (at < frame.length && frame[at] !== 0) at += 1; // MIME type, Latin-1.
    at += 1;
  }
  at += 1; // Picture type.
  // The description, ended by one zero byte, or two (aligned) in UTF-16.
  const wide = encoding === 1 || encoding === 2;
  while (at < frame.length) {
    if (!wide && frame[at] === 0) return at + 1;
    if (wide && frame[at] === 0 && frame[at + 1] === 0) return at + 2;
    at += wide ? 2 : 1;
  }
  return -1;
};

const imageType = (bytes) =>
  bytes[0] === 0x89 && bytes[1] === 0x50
    ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8
      ? "image/jpeg"
      : bytes[0] === 0x47 && bytes[1] === 0x49
        ? "image/gif"
        : "image/webp";

/** The cover picture in an ID3v2 tag at the start of `bytes`, or null. */
export const coverFromTag = (bytes) => {
  if (!isTag(bytes)) return null;
  const version = bytes[3];
  const flags = bytes[5];
  let tag = bytes.subarray(10, 10 + syncsafe(bytes, 6));
  if (version < 4 && flags & 0x80) tag = resync(tag);
  let at = 0;
  if (flags & 0x40) {
    // An extended header: its size counts itself in v2.4, not in v2.3.
    at =
      version === 4 ? syncsafe(tag, 0) : 4 + new DataView(tag.buffer, tag.byteOffset).getUint32(0);
  }
  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;
  let found = null;
  while (at + headerLength <= tag.length && tag[at] !== 0) {
    const id = String.fromCharCode(...tag.subarray(at, at + idLength));
    const size =
      version === 2
        ? (tag[at + 3] << 16) | (tag[at + 4] << 8) | tag[at + 5]
        : version === 4
          ? syncsafe(tag, at + 4)
          : new DataView(tag.buffer, tag.byteOffset + at + 4).getUint32(0);
    const frameFlags = version === 2 ? 0 : (tag[at + 8] << 8) | tag[at + 9];
    let frame = tag.subarray(at + headerLength, at + headerLength + size);
    at += headerLength + size;
    if (id !== "APIC" && id !== "PIC") continue;
    // Compressed or encrypted frames are left alone.
    if (frameFlags & 0x000c) continue;
    if (version === 4 && frameFlags & 0x0001) frame = frame.subarray(4);
    if (version === 4 && frameFlags & 0x0002) frame = resync(frame);
    const start = pictureStart(frame, version);
    if (start < 0 || start >= frame.length) continue;
    const typeAt = version === 2 ? 4 : frame.indexOf(0, 1) + 1;
    const picture = frame.subarray(start);
    if (!found || frame[typeAt] === FRONT_COVER) found = picture;
    if (frame[typeAt] === FRONT_COVER) break;
  }
  return found && new Blob([found], { type: imageType(found) });
};

/** The cover of the audio at `src`, as a Blob, or null. */
export const coverOf = async (src) => {
  const response = await fetch(src);
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  /** Reads on until `size` bytes are in, or the file ends. */
  const fill = async (size) => {
    while (total < size) {
      const { done, value } = await reader.read();
      if (done) return;
      chunks.push(value);
      total += value.length;
    }
  };
  const bytes = () => {
    const all = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    return all;
  };
  try {
    await fill(10);
    const head = bytes();
    if (!isTag(head)) return null;
    const size = 10 + syncsafe(head, 6);
    if (size > MAX_TAG_BYTES) return null;
    await fill(size);
  } finally {
    // The rest of the file is the music, which the player fetches itself.
    void reader.cancel().catch(() => {});
  }
  return coverFromTag(bytes());
};
