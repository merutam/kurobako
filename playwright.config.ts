import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
  },
  webServer: {
    command: "bun --no-env-file test/browser/server.ts",
    url: "http://127.0.0.1:33111/pilot/example",
    reuseExistingServer: false,
  },
});
