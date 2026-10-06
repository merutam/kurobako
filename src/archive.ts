// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Zip and tar, written and read as streams, with nothing kept in memory but
// the current entry's header. Only what backups need: regular files, stored
// without compression (most contents are images, archives or ciphertext,
// which do not compress), zip64 and pax for the largest files.
//
// The reader takes the archives this file writes, whose first entry is a
// manifest giving every other entry's size; it reads zip entries in order
// instead of through the central directory, so it never needs to seek.

export type ArchiveEntry = {
  path: string;
  size: number;
  modified: Date;
  /** The entry's bytes, exactly `size` of them; asked for when the entry is written. */
  open: () => Promise<ReadableStream<Uint8Array>>;
};

export type ArchiveFormat = "zip" | "tar";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- CRC-32 (zip) -------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (crc: number, bytes: Uint8Array) => {
  let c = ~crc >>> 0;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
};

// --- Byte layout --------------------------------------------------------------

/** Little-endian fields, as zip lays them out. */
class Fields {
  private readonly parts: number[] = [];
  u16(value: number) {
    this.parts.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }
  u32(value: number) {
    for (let shift = 0; shift < 32; shift += 8)
      this.parts.push(Math.floor(value / 2 ** shift) & 0xff);
    return this;
  }
  u64(value: number) {
    return this.u32(value % 2 ** 32).u32(Math.floor(value / 2 ** 32));
  }
  bytes(values: Uint8Array) {
    this.parts.push(...values);
    return this;
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;

/** MS-DOS date and time, as zip stores them (local time, 2-second steps). */
const dosTime = (date: Date) => ({
  time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  date:
    (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
});

// --- Writing ------------------------------------------------------------------

/** Pipes an entry's stream through `each`, checking it has exactly `size` bytes. */
async function* entryBytes(entry: ArchiveEntry, each?: (chunk: Uint8Array) => void) {
  const reader = (await entry.open()).getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > entry.size) throw new Error(`${entry.path} is larger than it said.`);
    each?.(value);
    yield value;
  }
  if (total !== entry.size) throw new Error(`${entry.path} is shorter than it said.`);
}

async function* zipChunks(entries: ArchiveEntry[]): AsyncGenerator<Uint8Array> {
  const central: Uint8Array[] = [];
  let offset = 0;
  const emit = (bytes: Uint8Array) => {
    offset += bytes.byteLength;
    return bytes;
  };

  for (const [index, entry] of entries.entries()) {
    const name = encoder.encode(entry.path);
    const { time, date } = dosTime(entry.modified);
    const start = offset;
    const big = entry.size >= MAX_U32 || start >= MAX_U32;
    // The first entry (the manifest) is small and written with its CRC up
    // front, so a reader learns its size from its own header. The others
    // carry theirs in a descriptor after the data (flag bit 3).
    const known = index === 0 && !big;
    let crc = 0;
    let buffered: Uint8Array | null = null;
    if (known) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of entryBytes(entry)) chunks.push(chunk);
      buffered = new Uint8Array(entry.size);
      let at = 0;
      for (const chunk of chunks) {
        buffered.set(chunk, at);
        at += chunk.byteLength;
      }
      crc = crc32(0, buffered);
    }
    // Bit 11: the name is UTF-8.
    const flags = known ? 0x0800 : 0x0808;
    const zip64Extra = big
      ? new Fields().u16(0x0001).u16(16).u64(0).u64(0).done()
      : new Uint8Array();
    yield emit(
      new Fields()
        .u32(0x04034b50)
        .u16(big ? 45 : 20)
        .u16(flags)
        .u16(0)
        .u16(time)
        .u16(date)
        .u32(crc)
        .u32(big ? MAX_U32 : known ? entry.size : 0)
        .u32(big ? MAX_U32 : known ? entry.size : 0)
        .u16(name.byteLength)
        .u16(zip64Extra.byteLength)
        .bytes(name)
        .bytes(zip64Extra)
        .done(),
    );
    if (buffered) {
      yield emit(buffered);
    } else {
      for await (const chunk of entryBytes(entry, (value) => (crc = crc32(crc, value)))) {
        yield emit(chunk);
      }
      const descriptor = new Fields().u32(0x08074b50).u32(crc);
      yield emit(
        (big
          ? descriptor.u64(entry.size).u64(entry.size)
          : descriptor.u32(entry.size).u32(entry.size)
        ).done(),
      );
    }

    // Its central directory record, with the real CRC and sizes.
    const extra = new Fields();
    if (big) {
      extra.u16(0x0001).u16(24).u64(entry.size).u64(entry.size).u64(start);
    }
    const extraBytes = extra.done();
    central.push(
      new Fields()
        .u32(0x02014b50)
        .u16(45)
        .u16(big ? 45 : 20)
        .u16(flags)
        .u16(0)
        .u16(time)
        .u16(date)
        .u32(crc)
        .u32(big ? MAX_U32 : entry.size)
        .u32(big ? MAX_U32 : entry.size)
        .u16(name.byteLength)
        .u16(extraBytes.byteLength)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32(0)
        .u32(big ? MAX_U32 : start)
        .bytes(name)
        .bytes(extraBytes)
        .done(),
    );
  }

  const centralStart = offset;
  for (const record of central) yield emit(record);
  const centralSize = offset - centralStart;
  const count = entries.length;
  if (count >= MAX_U16 || centralStart >= MAX_U32 || centralSize >= MAX_U32) {
    const zip64End = offset;
    yield emit(
      new Fields()
        .u32(0x06064b50)
        .u64(44)
        .u16(45)
        .u16(45)
        .u32(0)
        .u32(0)
        .u64(count)
        .u64(count)
        .u64(centralSize)
        .u64(centralStart)
        .done(),
    );
    yield emit(new Fields().u32(0x07064b50).u32(0).u64(zip64End).u32(1).done());
    yield emit(
      new Fields()
        .u32(0x06054b50)
        .u16(0)
        .u16(0)
        .u16(MAX_U16)
        .u16(MAX_U16)
        .u32(MAX_U32)
        .u32(MAX_U32)
        .u16(0)
        .done(),
    );
  } else {
    yield emit(
      new Fields()
        .u32(0x06054b50)
        .u16(0)
        .u16(0)
        .u16(count)
        .u16(count)
        .u32(centralSize)
        .u32(centralStart)
        .u16(0)
        .done(),
    );
  }
}

const TAR_BLOCK = 512;
/** The largest size a ustar header can hold: 11 octal digits. */
const TAR_MAX_SIZE = 8 ** 11 - 1;

const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

const tarHeader = (name: string, size: number, modified: Date, type: string) => {
  const header = new Uint8Array(TAR_BLOCK);
  const put = (at: number, text: string) => header.set(encoder.encode(text), at);
  put(0, name);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(Math.floor(modified.getTime() / 1000), 12));
  put(148, "        ");
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
};

/** A pax record: "<length> <key>=<value>\n", the length counting itself. */
const paxRecord = (key: string, value: string) => {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).byteLength;
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length += 1;
  return `${length}${body}`;
};

const padding = (size: number) => new Uint8Array((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);

async function* tarChunks(entries: ArchiveEntry[]): AsyncGenerator<Uint8Array> {
  for (const entry of entries) {
    // ustar holds short ASCII names and sizes below 8 GiB; pax the rest.
    const plain = /^[\x20-\x7e]{1,99}$/.test(entry.path);
    const huge = entry.size > TAR_MAX_SIZE;
    let name = entry.path;
    if (!plain || huge) {
      const records = encoder.encode(
        (plain ? "" : paxRecord("path", entry.path)) +
          (huge ? paxRecord("size", String(entry.size)) : ""),
      );
      yield tarHeader("PaxHeader", records.byteLength, entry.modified, "x");
      yield records;
      yield padding(records.byteLength);
      if (!plain) name = entry.path.replace(/[^\x20-\x7e]/g, "_").slice(-99);
    }
    yield tarHeader(name, huge ? 0 : entry.size, entry.modified, "0");
    yield* entryBytes(entry);
    yield padding(entry.size);
  }
  yield new Uint8Array(TAR_BLOCK * 2);
}

/** An archive of `entries`, generated as it is read. */
export const writeArchive = (format: ArchiveFormat, entries: ArchiveEntry[]) => {
  const chunks = format === "zip" ? zipChunks(entries) : tarChunks(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Each pull must enqueue something (or close), or the stream stalls.
        for (;;) {
          const { done, value } = await chunks.next();
          if (done) {
            controller.close();
            return;
          }
          if (value.byteLength) {
            controller.enqueue(value);
            return;
          }
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: async () => {
      await chunks.return(undefined);
    },
  });
};

// --- Reading ------------------------------------------------------------------

/** Reads a stream in exact amounts. */
class ByteReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private finished = false;
  // Typed by hand: the DOM's and Node's stream types disagree on readers.
  private readonly reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> };

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /** Whether at least `n` bytes are left (reading ahead as needed). */
  async has(n: number) {
    while (this.buffered < n && !this.finished) {
      const { done, value } = await this.reader.read();
      if (done) this.finished = true;
      else if (value?.byteLength) {
        this.chunks.push(value);
        this.buffered += value.byteLength;
      }
    }
    return this.buffered >= n;
  }

  /** Up to `n` bytes from what is buffered or next in the stream. */
  private async take(n: number) {
    if (!(await this.has(1))) throw new Error("The archive ends too early.");
    const first = this.chunks[0] as Uint8Array;
    const part = first.byteLength <= n ? first : first.subarray(0, n);
    if (part === first) this.chunks.shift();
    else this.chunks[0] = first.subarray(n);
    this.buffered -= part.byteLength;
    return part;
  }

  async read(n: number) {
    if (!(await this.has(n))) throw new Error("The archive ends too early.");
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const part = await this.take(n - at);
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }

  /** The first `n` bytes (fewer at the end), left in place. */
  async peek(n: number) {
    await this.has(n);
    const out = new Uint8Array(Math.min(n, this.buffered));
    let at = 0;
    for (const chunk of this.chunks) {
      if (at >= out.byteLength) break;
      const part = chunk.subarray(0, out.byteLength - at);
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }

  async skip(n: number) {
    let left = n;
    while (left > 0) left -= (await this.take(left)).byteLength;
  }

  /**
   * The next `n` bytes as a stream, and `finish`, which skips whatever of them
   * was left unread (an entry passed over), so the next entry starts right.
   */
  slice(n: number) {
    let left = n;
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (left === 0) {
          controller.close();
          return;
        }
        const part = await this.take(left);
        left -= part.byteLength;
        controller.enqueue(part.slice());
      },
    });
    const finish = async () => {
      await this.skip(left);
      left = 0;
    };
    return { stream, finish };
  }
}

export type ReadEntry = {
  path: string;
  size: number;
  /** Read it, in part or whole, before asking for the next entry; what is left is skipped. */
  body: ReadableStream<Uint8Array>;
};

const u16 = (bytes: Uint8Array, at: number) =>
  (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
const u32 = (bytes: Uint8Array, at: number) =>
  (u16(bytes, at) + u16(bytes, at + 2) * 2 ** 16) >>> 0;

/** Which format a stream's first bytes say it is. */
const formatOf = (head: Uint8Array): ArchiveFormat | null => {
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return "zip";
  if (decoder.decode(head.subarray(257, 262)) === "ustar") return "tar";
  return null;
};

/**
 * The entries of a zip or tar this file wrote, in order. `sizeOf` gives the
 * size of a zip entry that carries it after its data, from the manifest.
 */
export async function* readArchive(
  stream: ReadableStream<Uint8Array>,
  sizeOf: (path: string) => number | undefined,
): AsyncGenerator<ReadEntry> {
  const input = new ByteReader(stream);
  const format = formatOf(await input.peek(TAR_BLOCK));
  if (format === "zip") yield* readZip(input, sizeOf);
  else if (format === "tar") yield* readTar(input);
  else throw new Error("This is neither a zip nor a tar archive.");
}

async function* readZip(
  input: ByteReader,
  sizeOf: (path: string) => number | undefined,
): AsyncGenerator<ReadEntry> {
  for (;;) {
    const signature = u32(await input.read(4), 0);
    if (signature !== 0x04034b50) return; // the central directory: no more entries
    const header = await input.read(26);
    const flags = u16(header, 2);
    if (u16(header, 4) !== 0) throw new Error("Compressed zip entries are not supported.");
    const nameLength = u16(header, 22);
    const extraLength = u16(header, 24);
    const path = decoder.decode(await input.read(nameLength));
    const extra = await input.read(extraLength);
    // A zip64 field in the local header: sizes (and descriptor) are 64-bit.
    let zip64 = false;
    for (let at = 0; at + 4 <= extra.byteLength; ) {
      const id = u16(extra, at);
      const length = u16(extra, at + 2);
      if (id === 0x0001) zip64 = true;
      at += 4 + length;
    }
    const described = (flags & 0x08) !== 0;
    const size = described ? sizeOf(path) : u32(header, 18);
    if (size === undefined) throw new Error(`${path} is not in the manifest.`);
    const entry = input.slice(size);
    yield { path, size, body: entry.stream };
    await entry.finish();
    if (described) await input.skip(zip64 ? 24 : 16);
  }
}

async function* readTar(input: ByteReader): AsyncGenerator<ReadEntry> {
  let pax: Record<string, string> = {};
  for (;;) {
    if (!(await input.has(TAR_BLOCK))) return;
    const header = await input.read(TAR_BLOCK);
    if (header.every((byte) => byte === 0)) return;
    const field = (at: number, length: number) =>
      decoder.decode(header.subarray(at, at + length)).replace(/\0.*$/s, "");
    const type = field(156, 1) || "0";
    const size = pax.size ? Number(pax.size) : Number.parseInt(field(124, 12).trim() || "0", 8);
    if (type === "x" || type === "g") {
      const records = decoder.decode(await input.read(size));
      await input.skip(padding(size).byteLength);
      if (type === "x") {
        for (const match of records.matchAll(/(\d+) ([^=]+)=([^\n]*)\n/g)) {
          pax[match[2] as string] = match[3] as string;
        }
      }
      continue;
    }
    const prefix = field(345, 155);
    const path = pax.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    pax = {};
    if (type !== "0") {
      // Directories and the like: nothing a backup restores.
      await input.skip(size + padding(size).byteLength);
      continue;
    }
    const entry = input.slice(size);
    yield { path, size, body: entry.stream };
    await entry.finish();
    await input.skip(padding(size).byteLength);
  }
}
