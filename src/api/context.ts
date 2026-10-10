// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What every route shares: settings, the platform, the assembled pages and a
// few helpers. Built once by createApp and handed to each group of routes.
import type { Context, Hono } from "hono";
import type { AppConfig } from "../config";
import type { ActivityEvent } from "../hub";
import {
  NAMESPACE_MAX_LENGTH,
  NAMESPACE_PATTERN,
  type NamespaceRef,
  RESERVED_NAMESPACES,
  SEALED_NAME_MAX_LENGTH,
} from "../model";
import { LIVE, type WriteCheck } from "../namespace";
import { isAutomatedNetwork, networkKey } from "../networks";
import { siteViewOf, type WebAssets } from "../pages";
import type { Platform } from "../platform";
import { accessEvent, clientKey } from "../request-info";
import { CLIENT_PATH, PROTOCOL_PATH, PROTOCOL_VERSION } from "../routing";

export type AppEnv = {
  Bindings: object;
  /** `miss`: this request found nothing, as a route says when no 404 does (see misses.ts). */
  Variables: { miss: boolean };
};
export type AppContext = Context<AppEnv>;
export type App = Hono<AppEnv>;

/**
 * A request body of at most `limit` bytes, or null when it is larger: reading
 * stops there, whatever Content-Length says or leaves out.
 */
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

/** The header that proves authority to mutate an encrypted namespace. */
export const WRITE_KEY_HEADER = "write-key";

/** SHA-256 in hex: what a namespace keeps of its write key. */
export const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The write key a request carries, as its SHA-256; null without one. */
export const writeVerifier = async (c: AppContext) => {
  const key = c.req.header(WRITE_KEY_HEADER)?.trim();
  return key ? sha256Hex(key) : null;
};

export const createContext = (
  config: AppConfig,
  assets: WebAssets,
  platformOf: (c: AppContext) => Platform,
) => {
  const hub = (c: AppContext) => platformOf(c).hub();
  const namespace = (c: AppContext, ref: NamespaceRef) => platformOf(c).namespace(ref);
  const later = (c: AppContext, work: Promise<unknown>) => platformOf(c).later(c, work);
  const record = (c: AppContext, event: ActivityEvent) => later(c, hub(c).recordActivity(event));
  const clientIp = (c: AppContext) => platformOf(c).client(c).ip;
  /** Structured, so log viewers can filter on the fields. */
  const log = (c: AppContext, level: "info" | "warn", message: string) =>
    console[level]({ message, path: c.req.path, ip: clientIp(c) });
  /** Who is asking, for the namespace's access log; sent along with each operation. */
  const visit = (c: AppContext) => accessEvent(c, platformOf(c).client(c));

  const publicConfig = () => ({
    /** Where the site lives under its domain: "" for the root, or e.g. "/k". */
    base: config.basePath,
    /** Only those with the key may use it (see ACCESS_KEY). */
    private: config.accessKey !== null,
    /** The server's version, which k.mjs compares with its own when a request fails. */
    version: assets.version,
    /** The protocol, plain and encrypted, complete enough to write a client from. */
    /** The protocol's version (see PROTOCOL_VERSION). */
    protocol: PROTOCOL_VERSION,
    protocolUrl: `${config.basePath}${PROTOCOL_PATH}`,
    /** k.mjs: a client for the protocol, and a command line that speaks curl. */
    clientUrl: `${config.basePath}${CLIENT_PATH}`,
    maxFileBytes: config.maxFileBytes,
    maxTextBytes: config.maxTextBytes,
    inlineTextBytes: config.inlineTextBytes,
    itemTtlSeconds: config.itemTtlMs / 1000,
    maxItems: config.maxItems,
    /** Sends per client address per minute; more get 429 until the minute is over. */
    sendsPerMinute: config.sendsPerMinute,
    /** How hosting, cloud and VPN networks and Tor are treated: allow, limit or block (sends get 403). */
    automatedNetworks: config.automatedNetworks,
    /** Requests per client per minute that may find nothing; past them, reads get 429 a while. */
    missesPerMinute: config.missesPerMinute,
    /** The most every item together may take, in bytes (null: no limit); more get 507. */
    maxStorageBytes: config.maxStorageBytes,
    namespace: {
      pattern: NAMESPACE_PATTERN.source,
      maxLength: NAMESPACE_MAX_LENGTH,
      reserved: [...RESERVED_NAMESPACES],
    },
    sealed: { maxNameLength: SEALED_NAME_MAX_LENGTH },
    live: LIVE,
  });

  const siteView = siteViewOf(assets, config.basePath, publicConfig());
  const { appVersion } = siteView;
  const page = (c: AppContext, html: string) => {
    c.header("Cache-Control", "no-cache");
    return c.html(html);
  };
  /** A page view counts the visitor for the 24-hour stats (JSON and files do not). */
  const countVisitor = (c: AppContext) => {
    const { ip, country } = platformOf(c).client(c);
    later(c, hub(c).recordVisitor(ip, country));
  };
  const pageView = (c: AppContext, html: string) => {
    countVisitor(c);
    return page(c, html);
  };

  /** Sends are the costly part to abuse, so they are rate limited per address. */
  /** Whether the client comes from where automation lives (see networks.ts). */
  const automated = (c: AppContext) => isAutomatedNetwork(platformOf(c).client(c));

  /**
   * Who the send and miss limits count: the client (an IPv4 address or an
   * IPv6 /64), or with AUTOMATED_NETWORKS=limit, for automated networks, its
   * network block, so a script cannot spread over a provider's addresses.
   */
  const limitKey = (c: AppContext) => {
    const key = clientKey(clientIp(c));
    return config.automatedNetworks === "limit" && automated(c) ? networkKey(key) : key;
  };

  /** Why this send cannot go now, as the answer to give; null when it can. */
  const refuseSend = async (c: AppContext) => {
    if (config.automatedNetworks === "block" && automated(c)) {
      return jsonError(c, 403, "Sending from hosting networks, VPNs and Tor is turned off here.");
    }
    if (await platformOf(c).allowSend(c, limitKey(c))) return null;
    c.header("Retry-After", "60");
    return jsonError(c, 429, TOO_MANY_SENDS);
  };

  /**
   * Why this write to a namespace cannot go, as the answer to give; null
   * when it can. Plain names are write capabilities; an encrypted namespace
   * requires the key bound to its ID, including on its first send. A wrong
   * key counts as a miss, so keys cannot be guessed at speed.
   */
  const refuseWrite = async (c: AppContext, ref: NamespaceRef) => {
    const check = (await namespace(c, ref).checkWrite(ref, await writeVerifier(c))) as WriteCheck;
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

  /**
   * Whether `bytes` more fit under MAX_STORAGE_BYTES; when they do not, the
   * answer to send. Without a limit, nothing is asked of the hub.
   */
  const storageFull = async (c: AppContext, bytes: number) => {
    const limit = config.maxStorageBytes;
    if (limit === null) return null;
    if ((await hub(c).storedBytes()) + bytes <= limit) return null;
    return jsonError(
      c,
      507,
      `This Kurobako is full: it keeps at most ${limit} bytes. Delete some items, or wait for them to expire.`,
    );
  };

  return {
    config,
    assets,
    platformOf,
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
