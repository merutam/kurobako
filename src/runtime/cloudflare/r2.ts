// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { BlobStore } from "../../core/host";

export const r2Store = (bucket: R2Bucket): BlobStore => ({
  async put(key, body, size, contentType) {
    // R2 needs the length up front; FixedLengthStream also fails the upload
    // if the body does not match it.
    await bucket.put(key, body.pipeThrough(new FixedLengthStream(size)), {
      httpMetadata: { contentType },
    });
  },
  async get(key, range) {
    const object = await bucket.get(key, range ? { range } : {});
    return object ? { body: object.body, size: object.size } : null;
  },
  async delete(keys) {
    if (keys.length) await bucket.delete(keys);
  },
});
