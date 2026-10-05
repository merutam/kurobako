// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_ADMIN_KEY } from "./test/admin-key.ts";

// The tests set every variable they need; a developer's .env (wrangler reads
// it when there is no .dev.vars) must not change what they see.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";

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
