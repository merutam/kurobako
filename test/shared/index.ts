// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
//
// Only HTTP to the server, storage through the harness, so the Worker and the
// Bun server both run them.

import type { expect as vitestExpect } from "vitest";
import type { AppConfig } from "../../src/config";
import { encryptedTests } from "./encrypted";
import { itemsTests } from "./items";
import { limitsTests } from "./limits";
import { namespacesTests } from "./namespaces";
import { siteTests } from "./site";
import { toolsOf } from "./tools";

export type Harness = {
  describe: (name: string, body: () => void) => void;
  test: (name: string, body: () => Promise<void>, timeoutMs?: number) => void;
  expect: typeof vitestExpect;
  /** A different client address each time unless cf-connecting-ip is set. */
  call: (path: string, init?: RequestInit) => Promise<Response>;
  storedFiles: (prefix: string) => Promise<string[]>;
  config: AppConfig;
  /** So a test that spends a whole per-minute limit never straddles two windows. */
  limitWindow: () => Promise<void>;
  origin: string;
  adminKey: string;
};

export const sharedTests = (harness: Harness) => {
  const tools = toolsOf(harness);
  namespacesTests(harness, tools);
  limitsTests(harness, tools);
  encryptedTests(harness, tools);
  itemsTests(harness, tools);
  siteTests(harness, tools);
};
