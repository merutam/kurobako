// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// So core/ never knows whether it runs on Cloudflare or Bun (see src/runtime/).

export type SqlValue = string | number | null;

export interface Sql {
  exec<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T[];
}

export type ByteRange = { offset: number; length: number };

/** R2 on Cloudflare, any S3-compatible store elsewhere. */
export interface BlobStore {
  /** Fails, storing nothing, if the body is not exactly `size` bytes. */
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    size: number,
    contentType: string,
  ): Promise<void>;
  /** `size` is always the whole object's, even for a range. */
  get(
    key: string,
    range?: ByteRange,
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  delete(keys: string[]): Promise<void>;
}

export interface LiveSocket {
  send(message: string): void;
}

/**
 * On Cloudflare each core is a Durable Object reached by RPC, so every method
 * is async; on Bun the same calls are local. `methods` is all callers may use.
 */
export type Remote<T, K extends keyof T> = {
  [M in K]: T[M] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
