// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_ADMIN_KEY } from "./test/admin-key.ts";

export default defineConfig({
  // The Bun server has its own tests, run with `bun test`.
  test: { include: ["test/worker.test.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { ADMIN_KEY: TEST_ADMIN_KEY } },
    }),
  ],
});
