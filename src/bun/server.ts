// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Entry point for a self-hosted server: `bun src/bun/server.ts`. Settings
// come from environment variables, with the same names and defaults as the
// Worker's vars (see README.md), plus the ones below.

import { join } from "node:path";
import { S3Client, type Server } from "bun";
import { createApp } from "../app";
import { type AppConfig, loadConfig } from "../config";
import { ICON_FILES, loadAssets, STATIC_FILES } from "../pages";
import type { BlobStore } from "../platform";
import { logRequestLine, printJsonLines } from "./log";
import { type BunEnv, createBunPlatform } from "./platform";
import { s3Store } from "./s3";

const PUBLIC_DIR = join(import.meta.dir, "../../public");
const MAINTENANCE_MS = 30_000;
const CONTENT_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  ico: "image/x-icon",
  png: "image/png",
};
const ONE_DAY_SECONDS = 86_400;

export type ServerOptions = {
  config: AppConfig;
  dataDir: string;
  blobs: BlobStore;
  port: number;
  hostname?: string;
  clientIpHeader?: string | null;
  sendsPerMinute?: number;
  publicUrl?: string | null;
  maxOpenDatabases?: number;
  databaseIdleMs?: number;
  /** One log line per request; on unless turned off (tests do). */
  logRequests?: boolean;
};

/** Starts the server; returns it once timers are restored. */
export const startServer = async (options: ServerOptions) => {
  const { platform, websocket, resume, prune, close } = createBunPlatform({
    config: options.config,
    dataDir: options.dataDir,
    blobs: options.blobs,
    clientIpHeader: options.clientIpHeader ?? null,
    sendsPerMinute: options.sendsPerMinute ?? 30,
    publicUrl: options.publicUrl ?? null,
    maxOpenDatabases: options.maxOpenDatabases,
    databaseIdleMs: options.databaseIdleMs,
  });
  const assets = await loadAssets((path) => Bun.file(join(PUBLIC_DIR, path)).text());
  const app = createApp(options.config, assets, () => platform);

  /**
   * One JSON line per request (static files aside), as Workers Logs records
   * on Cloudflare: method, path, status, duration and the client's address.
   */
  const clientIp = (request: Request, server: Server<unknown>) => {
    const header = options.clientIpHeader;
    return header
      ? request.headers.get(header)?.split(",")[0]?.trim()
      : server.requestIP(request)?.address;
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

  /**
   * Pages load scripts and styles with ?v=<hash>.
   * Icons are requested at fixed URLs, so they are cached for a day.
   */
  const staticFile = (url: URL) => {
    const path = url.pathname.slice(1);
    const isIcon = ICON_FILES.includes(path);
    if (!isIcon && !STATIC_FILES.includes(path)) return null;
    const cacheControl = isIcon
      ? `public, max-age=${ONE_DAY_SECONDS}`
      : url.searchParams.has("v")
        ? "public, max-age=31536000, immutable"
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
  const largestBody = Math.max(options.config.maxFileBytes, options.config.maxTextBytes);
  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    // Room for the largest file plus the request around it.
    maxRequestBodySize: Math.min(Number.MAX_SAFE_INTEGER, largestBody + 1_000_000),
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
  // In a terminal, Bun's own output, in color; anywhere else, lines a log
  // collector can read.
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
    sendsPerMinute: Number(env.SENDS_PER_MINUTE || 30),
    publicUrl: env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : null,
    maxOpenDatabases: positiveInteger("SQLITE_MAX_OPEN", 1000),
    databaseIdleMs: positiveInteger("SQLITE_IDLE_SECONDS", 60) * 1000,
  });
  console.info(`Listening on ${server.url}`);
}
