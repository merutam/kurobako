// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Entry point on Cloudflare Workers. Static files are served by Workers
// Static Assets before the Worker runs (see run_worker_first in wrangler.jsonc).
import { createApp } from "../app";
import { loadConfig } from "../config";
import { logError } from "../log";
import { objectName } from "../model";
import { isPublicFile, loadAssets } from "../pages";
import type { NamespaceApi, Platform } from "../platform";
import { sitePath } from "../routing";
import { CLOUDFLARE_LIMITS } from "./limits";
import { hubOf, VISIT_HEADER } from "./objects";
import { r2Store } from "./r2";

export { HubObject, NamespaceObject } from "./objects";

/** Workers Logs for the signed-in account (the dashboard fills in ":account"). */
const LOGS_URL = "https://dash.cloudflare.com/?to=/:account/workers/observability";

const UNKNOWN = "unknown";
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/**
 * Clients past their misses (see src/api/misses.ts), until when. MISS_LIMITER
 * counts the misses; it can only be asked by counting one more, so its answer
 * is kept here, for this isolate: approximate, as the limiter is by design.
 */
const missBlocked = new Map<string, number>();

const platformFor = (env: Env, ctx: ExecutionContext): Platform => ({
  namespace: (ref) => env.NAMESPACES.getByName(objectName(ref)) as unknown as NamespaceApi,
  hub: () => hubOf(env),
  blobs: r2Store(env.BUCKET),
  live(c, ref, visit) {
    const url = new URL(c.req.url);
    url.searchParams.set("space", ref.space);
    url.searchParams.set("name", ref.name);
    const upgrade = new Request(url, c.req.raw);
    upgrade.headers.set(VISIT_HEADER, JSON.stringify(visit));
    return env.NAMESPACES.getByName(objectName(ref)).fetch(upgrade);
  },
  allowSend: async (_c, key) => (await env.UPLOAD_LIMITER.limit({ key })).success,
  recordMiss: async (_c, key) => {
    if ((await env.MISS_LIMITER.limit({ key })).success) return;
    const now = Date.now();
    if (missBlocked.size > 10_000) {
      for (const [stale, until] of missBlocked) if (until <= now) missBlocked.delete(stale);
    }
    missBlocked.set(key, now + 60_000);
  },
  missesExceeded: (_c, key) => (missBlocked.get(key) ?? 0) > Date.now(),
  later: (_c, work) =>
    ctx.waitUntil(work.catch((error: unknown) => logError("Background work failed", error))),
  client(c) {
    // `request.cf` has the location; the headers are the fallback (tests send them).
    const cf = (c.req.raw as { cf?: Record<string, unknown> }).cf ?? {};
    return {
      ip: c.req.header("cf-connecting-ip") || UNKNOWN,
      country: text(cf.country) ?? text(c.req.header("cf-ipcountry")),
      region: text(cf.region) ?? text(c.req.header("cf-region")),
      city: text(cf.city) ?? text(c.req.header("cf-ipcity")),
      // Cloudflare's own, which a client cannot fake; the header only where
      // there is no request.cf at all (tests).
      asn:
        typeof cf.asn === "number"
          ? cf.asn
          : Object.keys(cf).length
            ? null
            : Number(c.req.header("cf-asn")) || null,
    };
  },
  origin: (c) => new URL(c.req.url).origin,
  deployment: () => ({
    versionId: env.VERSION.id || null,
    deployedAt: env.VERSION.timestamp || null,
  }),
  logsUrl: LOGS_URL,
  logsHint: null,
});

const readAsset = (assets: Fetcher) => async (path: string) => {
  const response = await assets.fetch(new Request(`https://assets.invalid/${path}`));
  if (!response.ok) throw new Error(`Missing public/${path} (HTTP ${response.status}).`);
  return response.text();
};

const buildApp = async (env: Env) => {
  const config = loadConfig(env, CLOUDFLARE_LIMITS);
  const app = createApp(config, await loadAssets(readAsset(env.ASSETS)), (c) =>
    platformFor(c.env as Env, c.executionCtx as ExecutionContext),
  );
  return { app, basePath: config.basePath };
};

// Built once per isolate: assets and config only change with a new deployment.
let app: ReturnType<typeof buildApp> | null = null;

export default {
  async fetch(request, env, ctx) {
    app ??= buildApp(env).catch((error: unknown) => {
      app = null;
      throw error;
    });
    const { app: built, basePath } = await app;
    // Static assets live at the root of public/; under a base path, their
    // URLs (/k/common.js) find no asset and land here.
    if (basePath) {
      const inside = sitePath(basePath, new URL(request.url).pathname);
      if (inside && isPublicFile(inside)) {
        return env.ASSETS.fetch(new Request(new URL(inside, request.url), request));
      }
    }
    return built.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
