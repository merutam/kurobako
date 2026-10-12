// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Declared here, not taken from api/'s Api, so services never depend on the HTTP layer.
import type { AppConfig } from "../config";
import type { HubApi } from "../core/hub";
import type { NamespaceRef } from "../core/model";
import type { NamespaceApi } from "../core/namespace";
import type { Platform } from "../runtime/platform";

export type Deps = {
  config: AppConfig;
  hub: () => HubApi;
  namespace: (ref: NamespaceRef) => NamespaceApi;
  platform: Pick<Platform, "blobs">;
};
