// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Same settings and defaults as the Worker's vars (see README.md), plus the ones below.

import { join } from "node:path";
import { S3Client, type Server } from "bun";
import { createApp } from "../../app";
import { ASSETS_PATH, ICON_FILES, isAssetPath, isFixedFile, loadAssets } from "../../assets";
import { type Bundle, bundle } from "../../client/build";
import { type AppConfig, loadConfig } from "../../config";
import type { BlobStore } from "../../core/host";
import { sitePath } from "../../core/routing";
import { firstValue } from "../../core/visits";
import { logRequestLine, printJsonLines } from "./log";
import { type BunEnv, createBunPlatform } from "./platform";
import { s3Store } from "./s3";

const PUBLIC_DIR = join(import.meta.dir, "../../../public");
const MAINTENANCE_MS = 30_000;
const CONTENT_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  ico: "image/x-icon",
  png: "image/png",
};
const ONE_DAY_SECONDS = 86_400;

/** Once per process: every server in it shares it. */
let bundled: Promise<Bundle> | null = null;

export type ServerOptions = {
  config: AppConfig;
  dataDir: string;
  blobs: BlobStore;
  port: number;
  hostname?: string;
  clientIpHeader?: string | null;
  publicUrl?: string | null;
  maxOpenDatabases?: number;
  databaseIdleMs?: number;
  /** Tests turn it off. */
  logRequests?: boolean;
};

/** Returns once timers are restored, so nothing is due unnoticed. */
export const startServer = async (options: ServerOptions) => {
  const { platform, websocket, resume, prune, close } = createBunPlatform({
    config: options.config,
    dataDir: options.dataDir,
    blobs: options.blobs,
    clientIpHeader: options.clientIpHeader ?? null,
    sendsPerMinute: options.config.sendsPerMinute,
    publicUrl: options.publicUrl ?? null,
    maxOpenDatabases: options.maxOpenDatabases,
    databaseIdleMs: options.databaseIdleMs,
  });
  bundled ??= bundle();
  const { manifest, files } = await bundled;
  const assets = await loadAssets(async () => JSON.stringify(manifest));
  const app = createApp(options.config, assets, platform);

  /** As Workers Logs records on Cloudflare, so both read alike. */
  const clientIp = (request: Request, server: Server<unknown>) => {
    const header = options.clientIpHeader;
    return header ? firstValue(request.headers.get(header)) : server.requestIP(request)?.address;
  };

  const logRequest = (
    request: Request,
    url: URL,
    response: Response,
    started: number,
    ip: string | undefined,
  ) => {
    logRequestLine({
      method: request.method,
      path: url.pathname,
      status: response.status,
      ms: Math.round(performance.now() - started),
      ip: ip ?? "unknown",
    });
  };

  /** Bundles are named by contents (cached for good); fixed URLs are revalidated. */
  const staticFile = (url: URL) => {
    const inside = sitePath(options.config.basePath, url.pathname);
    if (!inside) return null;
    if (isAssetPath(inside)) {
      const file = files.get(inside.slice(ASSETS_PATH.length + 1));
      if (!file) return null;
      return new Response(file.body, {
        headers: {
          "Content-Type": file.type,
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (!isFixedFile(inside)) return null;
    const path = inside.slice(1);
    const cacheControl = ICON_FILES.includes(path)
      ? `public, max-age=${ONE_DAY_SECONDS}`
      : "no-cache";
    return new Response(Bun.file(join(PUBLIC_DIR, path)), {
      headers: {
        "Content-Type": CONTENT_TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream",
        "Cache-Control": cacheControl,
        "X-Content-Type-Options": "nosniff",
      },
    });
  };

  await resume();
  const pruning = setInterval(prune, MAINTENANCE_MS);
  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    // No limit here: each route bounds its own body, and a whole-instance backup may be larger.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.method === "GET") {
        const file = staticFile(url);
        if (file) return file;
      }
      const started = performance.now();
      // Read now: once a WebSocket upgrade takes the connection, it is gone.
      const ip = clientIp(request, server);
      const response = await app.fetch(request, { server } satisfies BunEnv);
      if (options.logRequests !== false) logRequest(request, url, response, started, ip);
      return response;
    },
    websocket,
  });
  return {
    server,
    stop: async () => {
      clearInterval(pruning);
      try {
        await server.stop(true);
      } finally {
        close();
      }
    },
  };
};

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const positiveInteger = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
};

if (import.meta.main) {
  if (!process.stdout.isTTY) printJsonLines();
  const env = process.env;
  const blobs = s3Store(
    new S3Client({
      endpoint: required("S3_ENDPOINT"),
      bucket: required("S3_BUCKET"),
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      region: env.S3_REGION || "us-east-1",
    }),
  );
  const { server } = await startServer({
    config: loadConfig(env),
    dataDir: env.DATA_DIR || "data",
    blobs,
    port: Number(env.PORT || 3000),
    hostname: env.HOST || "0.0.0.0",
    clientIpHeader: env.CLIENT_IP_HEADER?.toLowerCase() || null,
    publicUrl: env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : null,
    maxOpenDatabases: positiveInteger("SQLITE_MAX_OPEN", 1000),
    databaseIdleMs: positiveInteger("SQLITE_IDLE_SECONDS", 60) * 1000,
  });
  console.info(`Listening on ${server.url}`);
}
