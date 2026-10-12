// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Built once by createApp and shared by every group of routes.
import type { Context, Hono } from "hono";
import { siteViewOf, type WebAssets } from "../assets";
import type { AppConfig } from "../config";
import type { ActivityEvent } from "../core/hub";
import {
  NAMESPACE_MAX_LENGTH,
  NAMESPACE_PATTERN,
  type NamespaceRef,
  RESERVED_NAMESPACES,
  SEALED_NAME_MAX_LENGTH,
} from "../core/model";
import { LIVE, type WriteCheck } from "../core/namespace";
import { isAutomatedNetwork, networkKey } from "../core/networks";
import { CLIENT_PATH, PROTOCOL_PATH, PROTOCOL_VERSION } from "../core/routing";
import { type AccessEvent, clientKey } from "../core/visits";
import type { Platform } from "../runtime/platform";
import { storageRefusal } from "../services/storage";

export type AppEnv = {
  Bindings: object;
  /** Set when a route found nothing without answering 404 (see misses.ts). */
  Variables: { miss: boolean };
};
export type AppContext = Context<AppEnv>;
export type App = Hono<AppEnv>;

/** Stops reading at `limit`, whatever Content-Length claims. */
export const readLimited = async (c: AppContext, limit: number): Promise<Uint8Array | null> => {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  const body = c.req.raw.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
};

export const jsonError = (
  c: AppContext,
  status: 400 | 401 | 403 | 404 | 409 | 411 | 412 | 413 | 415 | 426 | 429 | 500 | 503 | 507,
  error: string,
) => c.json({ error }, status);

export const TOO_MANY_SENDS = "Too many sends from this address. Try again in a minute.";

export const WRITE_KEY_HEADER = "write-key";

/** Namespaces keep only the hash of their write key. */
export const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const writeVerifier = async (c: AppContext) => {
  const key = c.req.header(WRITE_KEY_HEADER)?.trim();
  return key ? sha256Hex(key) : null;
};

const accessEvent = (
  c: AppContext,
  client: Pick<AccessEvent, "ip" | "country" | "region" | "city">,
): AccessEvent => ({
  ...client,
  lastMethod: c.req.method,
  lastPath: c.req.path,
  userAgent: c.req.header("user-agent") || "",
});

export const createContext = (config: AppConfig, assets: WebAssets, platform: Platform) => {
  const hub = () => platform.hub();
  const namespace = (ref: NamespaceRef) => platform.namespace(ref);
  const later = (c: AppContext, work: Promise<unknown>) => platform.later(c, work);
  const record = (c: AppContext, event: ActivityEvent) => later(c, hub().recordActivity(event));
  const clientIp = (c: AppContext) => platform.client(c).ip;
  /** Structured, so log viewers can filter on the fields. */
  const log = (c: AppContext, level: "info" | "warn", message: string) =>
    console[level]({ message, path: c.req.path, ip: clientIp(c) });
  const visit = (c: AppContext) => accessEvent(c, platform.client(c));

  /** Served at /.well-known/kurobako and embedded in pages, so clients never guess limits. */
  const publicConfig = {
    base: config.basePath,
    private: config.accessKey !== null,
    /** k.mjs compares it with its own when a request fails. */
    version: assets.version,
    protocol: PROTOCOL_VERSION,
    protocolUrl: `${config.basePath}${PROTOCOL_PATH}`,
    clientUrl: `${config.basePath}${CLIENT_PATH}`,
    maxFileBytes: config.maxFileBytes,
    maxTextBytes: config.maxTextBytes,
    inlineTextBytes: config.inlineTextBytes,
    itemTtlSeconds: config.itemTtlMs / 1000,
    maxItems: config.maxItems,
    sendsPerMinute: config.sendsPerMinute,
    automatedNetworks: config.automatedNetworks,
    missesPerMinute: config.missesPerMinute,
    /** null: no limit. */
    maxStorageBytes: config.maxStorageBytes,
    namespace: {
      pattern: NAMESPACE_PATTERN.source,
      maxLength: NAMESPACE_MAX_LENGTH,
      reserved: [...RESERVED_NAMESPACES],
    },
    sealed: { maxNameLength: SEALED_NAME_MAX_LENGTH },
    /** null when the server sends no notifications. */
    push: config.push ? { publicKey: config.push.publicKey } : null,
    live: LIVE,
  };

  const siteView = siteViewOf(assets, config.basePath, publicConfig);
  const { appVersion } = siteView;
  const page = (c: AppContext, html: string) => {
    c.header("Cache-Control", "no-cache");
    return c.html(html);
  };
  /** Only pages count toward the visitor stats; JSON and files do not. */
  const countVisitor = (c: AppContext) => {
    const { ip, country } = platform.client(c);
    later(c, hub().recordVisitor(ip, country));
  };
  const pageView = (c: AppContext, html: string) => {
    countVisitor(c);
    return page(c, html);
  };

  const automated = (c: AppContext) => isAutomatedNetwork(platform.client(c));

  /**
   * With AUTOMATED_NETWORKS=limit, a whole network block counts as one, so a script cannot spread
   * over a provider's addresses.
   */
  const limitKey = (c: AppContext) => {
    const key = clientKey(clientIp(c));
    return config.automatedNetworks === "limit" && automated(c) ? networkKey(key) : key;
  };

  const refuseSend = async (c: AppContext) => {
    if (config.automatedNetworks === "block" && automated(c)) {
      return jsonError(c, 403, "Sending from hosting networks, VPNs and Tor is turned off here.");
    }
    if (await platform.allowSend(c, limitKey(c))) return null;
    c.header("Retry-After", "60");
    return jsonError(c, 429, TOO_MANY_SENDS);
  };

  /** A wrong key counts as a miss, so keys cannot be guessed at speed. */
  const refuseWrite = async (c: AppContext, ref: NamespaceRef) => {
    const check = (await namespace(ref).checkWrite(ref, await writeVerifier(c))) as WriteCheck;
    if (check === "open") return null;
    if (check === "missing") {
      return jsonError(c, 401, "Writing to an encrypted namespace needs its Write-Key.");
    }
    if (check === "wrong") {
      c.set("miss", true);
      return jsonError(c, 403, "Wrong write key for this namespace.");
    }
    return null;
  };

  const storageFull = async (c: AppContext, bytes: number) => {
    const refusal = await storageRefusal(config, hub, bytes);
    return refusal ? jsonError(c, 507, refusal) : null;
  };

  return {
    config,
    assets,
    platform,
    appVersion,
    siteView,
    hub,
    namespace,
    later,
    record,
    clientIp,
    log,
    visit,
    publicConfig,
    page,
    countVisitor,
    pageView,
    refuseSend,
    refuseWrite,
    limitKey,
    storageFull,
  };
};

export type Api = ReturnType<typeof createContext>;
