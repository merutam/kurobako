// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The namespace and hub cores on a single Bun process: one SQLite file per
// namespace (like one Durable Object each), one for the hub, files in any
// S3-compatible store and live updates over Bun's own WebSockets.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Context } from "hono";
import type { AppConfig } from "../config";
import { HubCore } from "../hub";
import { type NamespaceRef, objectName, plainName, type SpaceKind, sealedName } from "../model";
import { LIVE, NamespaceCore } from "../namespace";
import type { BlobStore, Client, HubApi, Platform } from "../platform";
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
};

type SocketData = { ref: NamespaceRef; snapshot: string };
export type BunEnv = { server: Server<SocketData> };

const MINUTE_MS = 60_000;
const HUB_START_DELAY_MS = MINUTE_MS;
const SPACES: { kind: SpaceKind; valid: (name: string) => string | null }[] = [
  { kind: "plain", valid: plainName },
  { kind: "sealed", valid: sealedName },
];

const header = (c: Context, name: string) => c.req.header(name) || null;

export const createBunPlatform = (options: BunOptions) => {
  const { config, dataDir, blobs } = options;
  for (const space of SPACES)
    mkdirSync(join(dataDir, "namespaces", space.kind), { recursive: true });

  // --- Hub ----------------------------------------------------------------
  const hubAlarm = new Alarm(() => hub.alarm());
  const hub: HubCore = new HubCore(config, {
    sql: sqlOf(openDatabase(join(dataDir, "hub.sqlite"))),
    ensureAlarm: async (time) => {
      if (hubAlarm.at === null) hubAlarm.set(time);
    },
    setAlarm: async (time) => hubAlarm.set(time),
    cleanUpNamespace: (ref) => namespaceOf(ref).core.cleanUpIfEmpty(ref),
  });

  // --- Namespaces ---------------------------------------------------------
  type Entry = {
    core: NamespaceCore;
    sockets: Set<ServerWebSocket<SocketData>>;
    alarm: Alarm;
    hasStorage(): boolean;
  };
  const namespaces = new Map<string, Entry>();

  const namespaceOf = (ref: NamespaceRef): Entry => {
    const key = objectName(ref);
    const known = namespaces.get(key);
    if (known) return known;

    const file = join(dataDir, "namespaces", ref.space, `${ref.name}.sqlite`);
    let db: Database | null = null;
    const sockets = new Set<ServerWebSocket<SocketData>>();
    const alarm = new Alarm(() => core.alarm());
    const hasStorage = () => db !== null || existsSync(file);
    const core: NamespaceCore = new NamespaceCore(config, {
      hasStorage,
      sql: () => {
        db ??= openDatabase(file);
        return sqlOf(db);
      },
      async deleteStorage() {
        alarm.set(null);
        db?.close();
        db = null;
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
      },
      setAlarm: async (time) => alarm.set(time),
      sockets: () => [...sockets],
      blobs,
      hub: () => hub as unknown as HubApi,
    });
    const entry = { core, sockets, alarm, hasStorage };
    namespaces.set(key, entry);
    return entry;
  };

  /** Forgets namespaces that hold nothing in memory or on disk. */
  const prune = () => {
    for (const [key, entry] of namespaces) {
      if (!entry.hasStorage() && !entry.sockets.size && entry.alarm.at === null)
        namespaces.delete(key);
    }
  };

  /** Timers do not survive a restart: rebuild them from what is on disk. */
  const resume = async () => {
    for (const space of SPACES) {
      for (const file of readdirSync(join(dataDir, "namespaces", space.kind))) {
        const name = space.valid(file.replace(/\.sqlite$/, ""));
        if (!file.endsWith(".sqlite") || !name) continue;
        await namespaceOf({ space: space.kind, name }).core.resume();
      }
    }
    hubAlarm.set(Date.now() + HUB_START_DELAY_MS);
  };

  // --- Sends per address ----------------------------------------------------
  const sends = new Map<string, { count: number; resetAt: number }>();
  const allowSend = (ip: string) => {
    const now = Date.now();
    if (sends.size > 10_000) {
      for (const [key, window] of sends) if (window.resetAt <= now) sends.delete(key);
    }
    const window = sends.get(ip);
    if (!window || window.resetAt <= now) {
      sends.set(ip, { count: 1, resetAt: now + MINUTE_MS });
      return true;
    }
    window.count += 1;
    return window.count <= options.sendsPerMinute;
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
        return c.json({ error: "Too many live connections. Try again later." }, 503);
      }
      const snapshot = await core.watch(ref, visit);
      const upgraded = server(c).upgrade(c.req.raw, { data: { ref, snapshot } });
      // After an upgrade Bun ignores the response.
      return upgraded
        ? new Response(null)
        : c.json({ error: "Expected a WebSocket upgrade." }, 426);
    },
    allowSend: async (_c, ip) => allowSend(ip),
    later: (_c, work) => {
      work.catch((error: unknown) =>
        console.error({ message: "Background work failed", error: String(error) }),
      );
    },
    client(c): Client {
      if (options.clientIpHeader) {
        return {
          ip: header(c, options.clientIpHeader)?.split(",")[0]?.trim() || "unknown",
          country: header(c, "cf-ipcountry"),
          region: header(c, "cf-region"),
          city: header(c, "cf-ipcity"),
        };
      }
      return {
        ip: server(c).requestIP(c.req.raw)?.address ?? "unknown",
        country: null,
        region: null,
        city: null,
      };
    },
    origin(c) {
      if (options.publicUrl) return options.publicUrl;
      const url = new URL(c.req.url);
      // Behind a trusted proxy, the address visitors used is in its headers.
      if (options.clientIpHeader) {
        const proto = header(c, "x-forwarded-proto")?.split(",")[0]?.trim();
        const host = header(c, "x-forwarded-host")?.split(",")[0]?.trim() ?? header(c, "host");
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
    entry.core
      .watchersChanged()
      .catch((error: unknown) =>
        console.error({ message: "Live update failed", error: String(error) }),
      );
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

  return { platform, websocket, resume, prune };
};
