// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_ADMIN_KEY } from "./test/admin-key.ts";

// The tests set every variable they need; a developer's .env (wrangler reads
// it when there is no .dev.vars) must not change what they see.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";

// Limits the tests spend whole, small enough to spend in a moment: each
// spent limit must fit in one of Cloudflare's minute windows (see
// limitWindow in test/worker.test.ts). Production keeps wrangler.jsonc's.
const TEST_LIMIT = 30;

export default defineConfig({
  // The Bun server has its own tests, run with `bun test`.
  test: { include: ["test/worker.test.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_KEY: TEST_ADMIN_KEY,
          SENDS_PER_MINUTE: String(TEST_LIMIT),
          MISSES_PER_MINUTE: String(TEST_LIMIT),
        },
        ratelimits: {
          UPLOAD_LIMITER: { namespace_id: "1001", simple: { limit: TEST_LIMIT, period: 60 } },
          MISS_LIMITER: { namespace_id: "1002", simple: { limit: TEST_LIMIT, period: 60 } },
        },
      },
    }),
  ],
});
