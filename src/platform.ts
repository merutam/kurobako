// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What the app needs from the place it runs on. Two implementations exist:
// Cloudflare Workers (src/cloudflare) and a Bun server (src/bun). Everything
// else in src/ is shared and must not depend on either.
import type { Context } from "hono";
import type { HubCore } from "./hub";
import type { NamespaceRef } from "./model";
import type { NamespaceCore } from "./namespace";
import type { AccessEvent } from "./request-info";

export type SqlValue = string | number | null;

/** A synchronous SQLite connection. */
export interface Sql {
  exec<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T[];
}

/** File contents: R2 on Cloudflare, any S3-compatible store elsewhere. */
export interface BlobStore {
  /** Fails, storing nothing, if the body is not exactly `size` bytes. */
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    size: number,
    contentType: string,
  ): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  delete(keys: string[]): Promise<void>;
}

/** An open live-update connection. */
export interface LiveSocket {
  send(message: string): void;
}

type Async<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** The operations a namespace offers to requests (possibly across an RPC boundary). */
export type NamespaceApi = Async<
  Pick<
    NamespaceCore,
    | "list"
    | "save"
    | "readText"
    | "claimObject"
    | "peek"
    | "locate"
    | "rename"
    | "remove"
    | "accessLog"
    | "cleanUpIfEmpty"
    | "restore"
  >
>;
export type HubApi = Async<
  Pick<
    HubCore,
    | "reportNamespace"
    | "forgetNamespace"
    | "recordActivity"
    | "recordVisitor"
    | "createShare"
    | "extendShare"
    | "resolveShare"
    | "forgetShare"
    | "loginLockedOut"
    | "loginFailed"
    | "loginSucceeded"
    | "stats"
    | "overview"
    | "namespacesPage"
    | "allNamespaces"
    | "storedBytes"
  >
>;

/** Where a request comes from, as far as the platform can tell. */
export type Client = Pick<AccessEvent, "ip" | "country" | "region" | "city"> & {
  /** The client's network (autonomous system number), when the platform knows it. */
  asn: number | null;
};

export interface Platform {
  namespace(ref: NamespaceRef): NamespaceApi;
  hub(): HubApi;
  blobs: BlobStore;
  /** Answers a WebSocket upgrade with the namespace's live updates. */
  live(c: Context, ref: NamespaceRef, visit: AccessEvent): Response | Promise<Response>;
  /** Whether this client may send another item now; `key` is its clientKey. */
  allowSend(c: Context, key: string): Promise<boolean>;
  /** Counts a request of this client that found nothing (see src/api/misses.ts). */
  recordMiss(c: Context, key: string): Promise<void>;
  /** Whether this client has found nothing too often lately to read anything now. */
  missesExceeded(c: Context, key: string): boolean;
  /** Keeps work going after the response; failures are logged. */
  later(c: Context, work: Promise<unknown>): void;
  client(c: Context): Client;
  /** The site's public address, as visitors reach it (for absolute links). */
  origin(c: Context): string;
  /** Shown on the admin dashboard. */
  deployment(c: Context): { versionId: string | null; deployedAt: string | null };
  /** Where request logs can be read, if anywhere besides standard output. */
  logsUrl: string | null;
  /** Without such a page, where to read them instead, shown on the admin dashboard. */
  logsHint: string | null;
}
