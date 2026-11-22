// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { BlobStore } from "../src/domain/host";
import { startServer } from "../src/infrastructure/bun/server";

const port = Number(process.env.PILOT_PORT || 3100);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("PILOT_PORT must be an integer between 0 and 65535.");
  process.exit(1);
}
let backend: Awaited<ReturnType<typeof startServer>> | undefined;
let pilot: ReturnType<typeof Bun.serve> | undefined;
let dataDir: string | undefined;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await pilot?.stop(true);
    await backend?.stop();
  } finally {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
}
try {
  let upstream = process.env.PILOT_UPSTREAM?.trim();
  if (!upstream) {
    dataDir = mkdtempSync(join(tmpdir(), "kurobako-pilot-"));
    const objects = new Map<string, Uint8Array<ArrayBuffer>>();
    const blobs: BlobStore = {
      async put(key, body, size) {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        if (bytes.length !== size) throw new Error("Upload length mismatch.");
        objects.set(key, bytes);
      },
      async get(key, range) {
        const bytes = objects.get(key);
        if (!bytes) return null;
        const part = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
        return { body: new Blob([part]).stream(), size: bytes.length };
      },
      async delete(keys) {
        for (const key of keys) objects.delete(key);
      },
    };
    backend = await startServer({
      config: loadConfig({}),
      dataDir,
      blobs,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
    upstream = backend.server.url.origin;
    console.info(`Temporary demo backend: ${upstream} (data is discarded on exit)`);
  }
  // Solid's compiled renderer has a separate build/typecheck from the Bun server.
  const serverPath = join(import.meta.dir, "../experiments/solid-namespace/server.ts");
  const { startPilot } = await import(serverPath);
  pilot = await startPilot({ upstream, port });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await stop();
  process.exitCode = 1;
}
