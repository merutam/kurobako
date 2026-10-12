// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Everything outside runtime/ is shared and must not depend on either platform.
import type { Context } from "hono";
import type { BlobStore } from "../core/host";
import type { HubApi } from "../core/hub";
import type { NamespaceRef } from "../core/model";
import type { NamespaceApi } from "../core/namespace";
import type { AccessEvent } from "../core/visits";

export type Client = Pick<AccessEvent, "ip" | "country" | "region" | "city"> & {
  /** When the platform knows it. */
  asn: number | null;
};

export interface Platform {
  namespace(ref: NamespaceRef): NamespaceApi;
  hub(): HubApi;
  blobs: BlobStore;
  live(c: Context, ref: NamespaceRef, visit: AccessEvent): Response | Promise<Response>;
  allowSend(c: Context, key: string): Promise<boolean>;
  recordMiss(c: Context, key: string): Promise<void>;
  missesExceeded(c: Context, key: string): boolean;
  /** Failures are logged, since nobody awaits them. */
  later(c: Context, work: Promise<unknown>): void;
  client(c: Context): Client;
  /** As visitors reach it, for absolute links. */
  origin(c: Context): string;
  deployment(c: Context): { versionId: string | null; deployedAt: string | null };
  /** null when standard output is the only place. */
  logsUrl: string | null;
  logsHint: string | null;
}
