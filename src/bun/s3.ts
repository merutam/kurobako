// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { S3Client } from "bun";
import type { BlobStore } from "../platform";

const isNotFound = (error: unknown) => {
  const { code, name } = (error ?? {}) as { code?: string; name?: string };
  return code === "NoSuchKey" || code === "NotFound" || name === "NoSuchKey";
};

/** Files in any S3-compatible store, such as MinIO. */
export const s3Store = (client: S3Client): BlobStore => ({
  async put(key, body, size, contentType) {
    const writer = client.file(key).writer({ type: contentType });
    let written = 0;
    try {
      for await (const chunk of body) {
        written += chunk.byteLength;
        if (written > size) throw new Error("The body is longer than its Content-Length.");
        await writer.write(chunk);
      }
      if (written !== size) throw new Error("The body ended before its Content-Length.");
      await writer.end();
    } catch (error) {
      // Closing the writer releases it, but keeps what was written: delete that.
      await Promise.resolve(writer.end(error as Error)).catch(() => {});
      await client.delete(key).catch(() => {});
      throw error;
    }
  },
  async get(key, range) {
    const file = client.file(key);
    try {
      const { size } = await file.stat();
      const body = range
        ? file.slice(range.offset, range.offset + range.length).stream()
        : file.stream();
      return { body, size };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
  async delete(keys) {
    await Promise.all(keys.map((key) => client.delete(key)));
  },
});
