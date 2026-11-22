// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The tests shared with the Worker, behind a pretend proxy.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { startServer } from "../../src/infrastructure/bun/server";
import { TEST_ADMIN_KEY } from "../admin-key";
import { type Harness, sharedTests } from "../shared/index";
import { memoryStore, useDefaultServer } from "./harness";

useDefaultServer();

/*
 * Behind a pretend proxy naming the client in cf-connecting-ip, so each call
 * can come from its own address, as on Cloudflare.
 */
describe("shared", () => {
  const sharedConfig = loadConfig({ ADMIN_KEY: TEST_ADMIN_KEY });
  const sharedDir = mkdtempSync(join(tmpdir(), "kurobako-shared-"));
  const sharedBlobs = memoryStore();
  let shared: Awaited<ReturnType<typeof startServer>>;
  let sharedBase = "";
  beforeAll(async () => {
    shared = await startServer({
      config: sharedConfig,
      dataDir: sharedDir,
      blobs: sharedBlobs.store,
      port: 0,
      hostname: "127.0.0.1",
      clientIpHeader: "cf-connecting-ip",
      logRequests: false,
    });
    sharedBase = shared.server.url.origin;
  });
  afterAll(async () => {
    await shared.stop();
    rmSync(sharedDir, { recursive: true, force: true });
  });

  sharedTests({
    describe,
    test,
    expect: expect as unknown as Harness["expect"],
    call: (path, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has("cf-connecting-ip")) {
        const [a, b] = crypto.getRandomValues(new Uint8Array(2));
        headers.set("cf-connecting-ip", `198.18.${a}.${b}`);
      }
      return fetch(`${sharedBase}${path}`, { ...init, headers });
    },
    storedFiles: async (prefix) =>
      [...sharedBlobs.objects.keys()].filter((key) => key.startsWith(prefix)),
    config: sharedConfig,
    // Each key's window starts at its first request here: always a whole one.
    limitWindow: async () => {},
    get origin() {
      return sharedBase;
    },
    adminKey: TEST_ADMIN_KEY,
  });

  test("points the admin to its logs, which have no page of their own here", async () => {
    const overview = (await (
      await fetch(`${sharedBase}/k/a/overview`, {
        headers: { authorization: `Bearer ${TEST_ADMIN_KEY}` },
      })
    ).json()) as { logsUrl: string | null; logsHint: string | null };
    expect(overview.logsUrl).toBeNull();
    expect(overview.logsHint).toContain("standard output");
  });
});
