// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Declared here, not taken from http/'s types, so application code never depends on the HTTP layer.
import type { AppConfig } from "../config";
import type { BlobStore } from "../domain/host";
import type { HubApi } from "../domain/hub";
import type { NamespaceRef } from "../domain/model";
import type { NamespaceApi } from "../domain/namespace";

export type Deps = {
  config: AppConfig;
  hub: () => HubApi;
  namespace: (ref: NamespaceRef) => NamespaceApi;
  /** Only storage: the rest of a platform is HTTP's (infrastructure/platform.ts). */
  platform: { blobs: BlobStore };
};
