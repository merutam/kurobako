import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import type { BlobStore } from "../../src/domain/host";
import { startServer } from "../../src/infrastructure/bun/server";

const dataDir = mkdtempSync(join(tmpdir(), "kurobako-browser-"));
const objects = new Map<string, Uint8Array>();
const blobs: BlobStore = {
  async put(key, body) {
    objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
  },
  async get(key) {
    const bytes = objects.get(key);
    return bytes ? { body: new Blob([bytes]).stream(), size: bytes.length } : null;
  },
  async delete(keys) {
    for (const key of keys) objects.delete(key);
  },
};
const running = await startServer({
  config: loadConfig({}),
  dataDir,
  blobs,
  port: 33110,
  hostname: "127.0.0.1",
  logRequests: false,
});
process.on("SIGTERM", async () => {
  await running.stop();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
});
