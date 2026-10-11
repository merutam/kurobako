// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The platform on Cloudflare Workers: namespaces and the hub are Durable
// Objects (objects.ts), files are in R2, sends and misses are counted by
// Workers rate limiters. Built once per isolate, from the Worker's bindings.
import { logError } from "../../core/log";
import { objectName } from "../../core/model";
import type { NamespaceApi } from "../../core/namespace";
import type { Platform } from "../platform";
import { hubOf, VISIT_HEADER } from "./objects";
import { r2Store } from "./r2";

/** Workers Logs for the signed-in account (the dashboard fills in ":account"). */
const LOGS_URL = "https://dash.cloudflare.com/?to=/:account/workers/observability";

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export const createCloudflarePlatform = (env: Env): Platform => {
  const namespaceOf = (ref: Parameters<Platform["namespace"]>[0]) =>
    env.NAMESPACES.getByName(objectName(ref));
  /**
   * Clients past their misses (see src/api/misses.ts), until when. MISS_LIMITER
   * counts the misses; it can only be asked by counting one more, so its answer
   * is kept here, for this isolate: approximate, as the limiter is by design.
   */
  const missBlocked = new Map<string, number>();

  return {
    namespace: (ref) => namespaceOf(ref) as unknown as NamespaceApi,
    hub: () => hubOf(env),
    blobs: r2Store(env.BUCKET),
    live(c, ref, visit) {
      const url = new URL(c.req.url);
      url.searchParams.set("space", ref.space);
      url.searchParams.set("name", ref.name);
      const upgrade = new Request(url, c.req.raw);
      upgrade.headers.set(VISIT_HEADER, JSON.stringify(visit));
      return namespaceOf(ref).fetch(upgrade);
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
    later: (c, work) =>
      c.executionCtx.waitUntil(
        work.catch((error: unknown) => logError("Background work failed", error)),
      ),
    client(c) {
      // `request.cf` has the location; the headers are the fallback (tests send them).
      const cf = (c.req.raw as { cf?: Record<string, unknown> }).cf ?? {};
      return {
        ip: c.req.header("cf-connecting-ip") || "unknown",
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
  };
};
