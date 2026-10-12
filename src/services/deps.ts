// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What services are built from. Declared here rather than taken from api/'s
// Api, so services never depend on the HTTP layer; Api fits it as it is.
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
