// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The Bun tests' shared setup: a default server per file, and helpers to reach it.
import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, loadConfig } from "../../src/config";
import type { BlobStore } from "../../src/domain/host";
import { startServer } from "../../src/infrastructure/bun/server";
import type { Item, LiveMessage } from "../support";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const memoryStore = () => {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const store: BlobStore = {
    async put(key, body, size) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (bytes.byteLength !== size) throw new Error("Length mismatch.");
      objects.set(key, bytes);
    },
    async get(key, range) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const part = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
      return { body: new Blob([part]).stream(), size: bytes.byteLength };
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
  };
  return { store, objects };
};

const config: AppConfig = {
  ...loadConfig({}),
  // These tests read many things that are not there, from one address.
  missesPerMinute: 1_000,
  // Short enough to watch a cleanup happen.
  emptyNamespaceTtlMs: 300,
  maxItems: 3,
};
/** Each file's default server: made in its beforeAll, removed in its afterAll. */
let dataDir = "";
let blobs = memoryStore();
let running: Awaited<ReturnType<typeof startServer>>;
let base = "";

/** Off, but for the test about them. */
let logRequests = false;
const setLogRequests = (on: boolean) => {
  logRequests = on;
};
const start = async () => {
  running = await startServer({
    config,
    dataDir,
    blobs: blobs.store,
    port: 0,
    hostname: "127.0.0.1",
    logRequests,
    maxOpenDatabases: 2,
  });
  base = running.server.url.origin;
};
/** A server on a free port for the file's tests, as `base`, `call` and `json` reach it. */
const useDefaultServer = () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "kurobako-test-"));
    blobs = memoryStore();
    await start();
  });
  afterAll(async () => {
    await running.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
};

const call = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

const json = async <T>(path: string, init?: RequestInit) =>
  (await call(path, init)).json() as Promise<T>;
const fresh = () => `b${crypto.randomUUID().slice(0, 8)}`;
const typed = (ns: string, text: string, headers: Record<string, string> = {}) =>
  json<Item>(`/${ns}/new`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: text,
  });
/** Viewer counts in between are skipped. */
const nextMessage = <T extends "ready" | "change">(socket: WebSocket, type: T) =>
  new Promise<Extract<LiveMessage, { type: T }>>((resolve) => {
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as LiveMessage;
      if (message.type !== type) return;
      socket.removeEventListener("message", listener);
      resolve(message as Extract<LiveMessage, { type: T }>);
    };
    socket.addEventListener("message", listener);
  });

export {
  base,
  blobs,
  call,
  config,
  dataDir,
  fresh,
  json,
  logRequests,
  memoryStore,
  nextMessage,
  png,
  running,
  setLogRequests,
  start,
  typed,
  useDefaultServer,
};
