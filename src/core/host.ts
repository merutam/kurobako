// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What the cores (namespace/, hub.ts) need from wherever they run: a SQLite
// connection, a store for file contents and live sockets. Cloudflare and Bun
// each provide them (src/runtime/); nothing in core/ knows which.

export type SqlValue = string | number | null;

/** A synchronous SQLite connection. */
export interface Sql {
  exec<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T[];
}

/** Some of an object's bytes: `length` of them from `offset`. */
export type ByteRange = { offset: number; length: number };

/** File contents: R2 on Cloudflare, any S3-compatible store elsewhere. */
export interface BlobStore {
  /** Fails, storing nothing, if the body is not exactly `size` bytes. */
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    size: number,
    contentType: string,
  ): Promise<void>;
  /**
   * The object, or with `range` only those bytes of it; `size` is always the
   * whole object's.
   */
  get(
    key: string,
    range?: ByteRange,
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  delete(keys: string[]): Promise<void>;
}

/** An open live-update connection. */
export interface LiveSocket {
  send(message: string): void;
}

/**
 * A core as its callers see it: on Cloudflare each core is a Durable Object
 * reached by RPC, so every method is async; on Bun the same calls are local.
 * `methods` lists what callers may use (the Durable Objects expose exactly
 * those, see src/runtime/cloudflare/objects.ts).
 */
export type Remote<T, K extends keyof T> = {
  [M in K]: T[M] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
