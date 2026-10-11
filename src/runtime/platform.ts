// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What the app needs from the place it runs on. Two implementations exist:
// Cloudflare Workers (cloudflare/) and a Bun server (bun/), each with a
// platform.ts that builds this. Everything outside runtime/ is shared and
// must not depend on either.
import type { Context } from "hono";
import type { BlobStore } from "../core/host";
import type { HubApi } from "../core/hub";
import type { NamespaceRef } from "../core/model";
import type { NamespaceApi } from "../core/namespace";
import type { AccessEvent } from "../core/visits";

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
