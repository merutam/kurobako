// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The namespace and hub cores on a single Bun process: one SQLite file per
// namespace (like one Durable Object each), one for the hub, files in any
// S3-compatible store and live updates over Bun's own WebSockets.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Context } from "hono";
import { jsonError } from "../../api/context";
import type { AppConfig } from "../../config";
import type { BlobStore } from "../../core/host";
import type { HubApi } from "../../core/hub";
import { HubCore } from "../../core/hub";
import { logError } from "../../core/log";
import { type NamespaceRef, objectName, type SpaceKind } from "../../core/model";
import { LIVE, NamespaceCore } from "../../core/namespace";
import { firstValue } from "../../core/visits";
import type { Client, Platform } from "../platform";
import { Alarm, openDatabase, sqlOf } from "./sqlite";

export type BunOptions = {
  config: AppConfig;
  /** Where the SQLite files live. */
  dataDir: string;
  blobs: BlobStore;
  /**
   * Set only behind a reverse proxy: the header holding the client's address
   * (e.g. "x-forwarded-for"). Location headers (cf-ipcountry, cf-region,
   * cf-ipcity) are then trusted as well.
   */
  clientIpHeader: string | null;
  /** Sends allowed per address per minute. */
  sendsPerMinute: number;
  /** The site's public address (e.g. https://box.example); unset, it comes from each request. */
  publicUrl: string | null;
  /** Namespace databases kept open at once. The least recently used is closed first. */
  maxOpenDatabases?: number;
  /** Close an unused namespace database on the next prune after this many milliseconds. */
  databaseIdleMs?: number;
};

type SocketData = { ref: NamespaceRef; snapshot: string };
export type BunEnv = { server: Server<SocketData> };

const MINUTE_MS = 60_000;
const HUB_START_DELAY_MS = MINUTE_MS;
/** One folder of SQLite files for each kind of namespace. */
const SPACES: SpaceKind[] = ["plain", "sealed"];

const header = (c: Context, name: string) => c.req.header(name) || null;
/** An ASN as a header gives it, or null. */
const asnOf = (value: string | null) => {
  const asn = Number(value);
  return value && Number.isSafeInteger(asn) && asn > 0 ? asn : null;
};

export const createBunPlatform = (options: BunOptions) => {
  const { config, dataDir, blobs } = options;
  const maxOpenDatabases = Math.max(1, options.maxOpenDatabases ?? 1000);
  const databaseIdleMs = Math.max(0, options.databaseIdleMs ?? 60_000);
  for (const space of SPACES) mkdirSync(join(dataDir, "namespaces", space), { recursive: true });

  // --- Hub ----------------------------------------------------------------
  const hubAlarm = new Alarm(() => hub.alarm());
  const hubDatabase = openDatabase(join(dataDir, "hub.sqlite"));
  const hub: HubCore = new HubCore(config, {
    sql: sqlOf(hubDatabase),
    ensureAlarm: async (time) => {
      if (hubAlarm.at === null) hubAlarm.set(time);
    },
    setAlarm: async (time) => hubAlarm.set(time),
    cleanUpNamespace: (ref) => namespaceOf(ref).core.cleanUpIfEmpty(ref),
  });

  // Every namespace's next alarm, so a restart restores timers without opening
  // each namespace's database. Kept next to the hub's tables, apart from them.
  hubDatabase.run(`CREATE TABLE IF NOT EXISTS namespace_alarms (
    space TEXT NOT NULL,
    name TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (space, name)
  ) WITHOUT ROWID`);
  const saveAlarm = (ref: NamespaceRef, time: number | null) => {
    if (time === null) {
      hubDatabase
        .query("DELETE FROM namespace_alarms WHERE space = ? AND name = ?")
        .run(ref.space, ref.name);
    } else {
      hubDatabase
        .query("INSERT OR REPLACE INTO namespace_alarms (space, name, at) VALUES (?, ?, ?)")
        .run(ref.space, ref.name, time);
    }
  };

  // --- Namespaces ---------------------------------------------------------
  type Entry = {
    core: NamespaceCore;
    sockets: Set<ServerWebSocket<SocketData>>;
    alarm: Alarm;
    hasStorage(): boolean;
    closeDatabase(): void;
  };
  const namespaces = new Map<string, Entry>();
  const openDatabases = new Map<string, { close: () => void; lastUsed: number }>();

  const namespaceOf = (ref: NamespaceRef): Entry => {
    const key = objectName(ref);
    const known = namespaces.get(key);
    if (known) return known;

    const file = join(dataDir, "namespaces", ref.space, `${ref.name}.sqlite`);
    let db: Database | null = null;
    const sockets = new Set<ServerWebSocket<SocketData>>();
    const alarm = new Alarm(() => core.alarm());
    const hasStorage = () => db !== null || existsSync(file);
    const closeDatabase = () => {
      openDatabases.delete(key);
      db?.close();
      db = null;
    };
    const touchDatabase = () => {
      openDatabases.delete(key);
      openDatabases.set(key, { close: closeDatabase, lastUsed: Date.now() });
      while (openDatabases.size > maxOpenDatabases) {
        const oldest = openDatabases.values().next().value as
          | { close: () => void; lastUsed: number }
          | undefined;
        oldest?.close();
      }
    };
    const core: NamespaceCore = new NamespaceCore(config, {
      hasStorage,
      sql: () => {
        db ??= openDatabase(file);
        touchDatabase();
        return sqlOf(db);
      },
      async deleteStorage() {
        alarm.set(null);
        saveAlarm(ref, null);
        closeDatabase();
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
      },
      setAlarm: async (time) => {
        alarm.set(time);
        saveAlarm(ref, time);
      },
      sockets: () => [...sockets],
      blobs,
      hub: () => hub as unknown as HubApi,
    });
    const entry = { core, sockets, alarm, hasStorage, closeDatabase };
    namespaces.set(key, entry);
    return entry;
  };

  /** Forgets namespaces that hold nothing in memory or on disk. */
  const prune = () => {
    const idleBefore = Date.now() - databaseIdleMs;
    for (const open of [...openDatabases.values()]) {
      if (open.lastUsed <= idleBefore) open.close();
    }
    for (const [key, entry] of namespaces) {
      if (!entry.hasStorage() && !entry.sockets.size && entry.alarm.at === null)
        namespaces.delete(key);
    }
  };

  /**
   * Timers do not survive a restart: rebuild them from the alarm index. Those
   * already due run right away. No one is connected anymore.
   */
  const resume = async () => {
    const alarms = hubDatabase
      .query("SELECT space, name, at FROM namespace_alarms")
      .all() as (NamespaceRef & { at: number })[];
    for (const { at, ...ref } of alarms) namespaceOf(ref).alarm.set(at);
    await hub.resetConnections();
    hubAlarm.set(Date.now() + HUB_START_DELAY_MS);
  };

  // --- Sends per client (see clientKey) --------------------------------------
  const sends = new Map<string, { count: number; resetAt: number }>();
  const allowSend = (key: string) => {
    const now = Date.now();
    if (sends.size > 10_000) {
      for (const [stale, window] of sends) if (window.resetAt <= now) sends.delete(stale);
    }
    const window = sends.get(key);
    if (!window || window.resetAt <= now) {
      sends.set(key, { count: 1, resetAt: now + MINUTE_MS });
      return true;
    }
    window.count += 1;
    return window.count <= options.sendsPerMinute;
  };

  // --- Misses per client (see src/api/misses.ts) ------------------------------
  const misses = new Map<string, { count: number; resetAt: number }>();
  const recordMiss = (key: string) => {
    const now = Date.now();
    if (misses.size > 10_000) {
      for (const [stale, window] of misses) if (window.resetAt <= now) misses.delete(stale);
    }
    const window = misses.get(key);
    if (!window || window.resetAt <= now) misses.set(key, { count: 1, resetAt: now + MINUTE_MS });
    else window.count += 1;
  };
  const missesExceeded = (key: string) => {
    const window = misses.get(key);
    return Boolean(window && window.resetAt > Date.now() && window.count > config.missesPerMinute);
  };

  const startedAt = new Date().toISOString();
  const server = (c: Context) => (c.env as BunEnv).server;

  const platform: Platform = {
    namespace: (ref) => namespaceOf(ref).core,
    hub: () => hub as unknown as HubApi,
    blobs,
    async live(c, ref, visit) {
      const { core } = namespaceOf(ref);
      if (!core.canWatch()) {
        return jsonError(c, 503, "Too many live connections. Try again later.");
      }
      const snapshot = await core.watch(visit);
      const upgraded = server(c).upgrade(c.req.raw, { data: { ref, snapshot } });
      // After an upgrade Bun ignores the response.
      return upgraded ? new Response(null) : jsonError(c, 426, "Expected a WebSocket upgrade.");
    },
    allowSend: async (_c, key) => allowSend(key),
    recordMiss: async (_c, key) => recordMiss(key),
    missesExceeded: (_c, key) => missesExceeded(key),
    later: (_c, work) => {
      work.catch((error: unknown) => logError("Background work failed", error));
    },
    client(c): Client {
      if (options.clientIpHeader) {
        return {
          ip: firstValue(header(c, options.clientIpHeader)) ?? "unknown",
          country: header(c, "cf-ipcountry"),
          region: header(c, "cf-region"),
          city: header(c, "cf-ipcity"),
          // Set by the proxy in front, as Cloudflare does with a Transform
          // Rule (ip.src.asnum); trusted with the address, never otherwise.
          asn: asnOf(header(c, "cf-asn")),
        };
      }
      return {
        ip: server(c).requestIP(c.req.raw)?.address ?? "unknown",
        country: null,
        region: null,
        city: null,
        asn: null,
      };
    },
    origin(c) {
      if (options.publicUrl) return options.publicUrl;
      const url = new URL(c.req.url);
      // Behind a trusted proxy, the address visitors used is in its headers.
      if (options.clientIpHeader) {
        const proto = firstValue(header(c, "x-forwarded-proto"));
        const host = firstValue(header(c, "x-forwarded-host")) ?? header(c, "host");
        return `${proto || url.protocol.slice(0, -1)}://${host || url.host}`;
      }
      return url.origin;
    },
    deployment: () => ({ versionId: null, deployedAt: startedAt }),
    logsUrl: null,
    logsHint:
      "Requests and errors go to the server's standard output, one JSON line each. With compose: podman compose logs -f kurobako",
  };

  const report = (entry: Entry) =>
    entry.core.watchersChanged().catch((error: unknown) => logError("Live update failed", error));
  const websocket: WebSocketHandler<SocketData> = {
    open(socket) {
      const entry = namespaceOf(socket.data.ref);
      entry.sockets.add(socket);
      socket.send(socket.data.snapshot);
      void report(entry);
    },
    message(socket, message) {
      if (message === LIVE.ping) socket.send(LIVE.pong);
    },
    close(socket) {
      const entry = namespaceOf(socket.data.ref);
      if (entry.sockets.delete(socket)) void report(entry);
    },
  };

  const close = () => {
    hubAlarm.set(null);
    for (const entry of namespaces.values()) {
      entry.alarm.set(null);
      entry.closeDatabase();
    }
    hubDatabase.close();
  };

  return { platform, websocket, resume, prune, close };
};
