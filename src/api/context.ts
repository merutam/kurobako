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
import { LIVE } from "../namespace";
import { escapeHtml, staticFiles, type WebAssets } from "../pages";
import type { Platform } from "../platform";
import { accessEvent } from "../request-info";
import { CLIENT_PATH, PROTOCOL_PATH } from "../routing";

export type AppEnv = { Bindings: object };
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
  status: 400 | 401 | 404 | 411 | 413 | 415 | 426 | 429 | 500 | 503 | 507,
  error: string,
) => c.json({ error }, status);

export const TOO_MANY_SENDS = "Too many sends from this address. Try again in a minute.";

export const createContext = (
  config: AppConfig,
  assets: WebAssets,
  platformOf: (c: AppContext) => Platform,
) => {
  const site = staticFiles(assets.files);
  const appVersion = `${assets.version} (build ${site.version})`;

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

  /**
   * Pages are assembled once: script URLs versioned, version in the footer,
   * and the public config embedded, which saves every page a request for it.
   */
  const embeddedConfig = JSON.stringify(publicConfig()).replaceAll("<", "\\u003c");
  // Links in pages are written from the site's root; under a base path they
  // get it in front.
  const rebased = (html: string) =>
    config.basePath
      ? html.replace(/\b(src|href|action)="\/(?!\/)/g, `$1="${config.basePath}/`)
      : html;
  const build = (html: string) =>
    rebased(site.versioned(html))
      .replaceAll("%APP_VERSION%", escapeHtml(appVersion))
      // Quoted in the pages, so they stay valid JSON until filled in.
      .replaceAll('"%CONFIG%"', embeddedConfig);
  const pages = {
    home: build(assets.homeHtml),
    namespace: build(assets.namespaceHtml),
    admin: build(assets.adminHtml),
    item: build(assets.itemHtml),
    protocol: build(assets.protocolHtml),
    login: build(assets.loginHtml),
  };
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
  const sendAllowed = async (c: AppContext) => {
    if (await platformOf(c).allowSend(c, clientIp(c))) return true;
    c.header("Retry-After", "60");
    return false;
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
    hub,
    namespace,
    later,
    record,
    clientIp,
    log,
    visit,
    publicConfig,
    build,
    pages,
    page,
    countVisitor,
    pageView,
    sendAllowed,
    storageFull,
  };
};

export type Api = ReturnType<typeof createContext>;
