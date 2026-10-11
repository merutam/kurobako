// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A front for several Kurobako servers, each with its own data directory and
// hub, sharing one S3 store: `SERVERS=http://10.0.0.1:3000,http://10.0.0.2:3000
// bun src/runtime/bun/router.ts`. It keeps no state. Each namespace and its share
// links go to the server that owns their slot (see routing.ts), with live
// connections relayed both ways. The admin dashboard shows one server at a
// time, picked with ?server=<n> (1 is the first); logins always go to the
// first, which keeps the lockout in one place. Other pages go by the
// visitor's address, so the same visitor keeps landing on one server. /stats.json adds up every server's. Each server keeps its
// own limits.

import type { Server, ServerWebSocket } from "bun";
import { loadConfig } from "../../config";
import { logError } from "../../core/log";
import { ADMIN_PATH, routeOf, sitePath, slotOfKey, slotOwners } from "../../core/routing";
import { firstValue } from "../../core/visits";
import { printJsonLines } from "./log";

export type RouterOptions = {
  /** The servers' addresses, the same list and order on every router. */
  servers: string[];
  port: number;
  hostname?: string;
  /** Set only behind a reverse proxy: the header holding the client's address. */
  clientIpHeader?: string | null;
  /** The servers' BASE_PATH, if they have one. */
  basePath?: string;
};

/** Hop-by-hop headers, and those the router sets itself. */
const DROPPED_HEADERS = [
  "connection",
  "keep-alive",
  "upgrade",
  "transfer-encoding",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
];
/** Where the client is, as servers behind a proxy read it; trusted only from a proxy. */
const LOCATION_HEADERS = ["cf-ipcountry", "cf-region", "cf-ipcity"];
const STATS_TTL_MS = 30_000;
/** `path` is a request's path inside the site (see sitePath). */
const isAdmin = (path: string) => path === ADMIN_PATH || path.startsWith(`${ADMIN_PATH}/`);
const STATS_TIMEOUT_MS = 5_000;

type Relay = {
  target: string;
  headers: Headers;
  upstream?: WebSocket;
  /** What the client sent before the server's side was open. */
  pending: (string | Uint8Array<ArrayBuffer>)[];
};

/** Bun's WebSocket client also takes request headers, which the DOM types leave out. */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: { headers: Headers },
) => WebSocket;

/** A close code a server may send: 1000, or one of the application's own. */
const closeCode = (code: number) => (code === 1000 || (code >= 3000 && code < 5000) ? code : 1011);

const unreachable = () =>
  Response.json(
    { error: "This part of the service is unreachable. Try again later." },
    { status: 502 },
  );

/** Sums every number; the top countries are merged, then cut to the longest list given. */
export const mergeStats = (all: Record<string, unknown>[]) => {
  const merged: Record<string, unknown> = {};
  const countries = new Map<string, number>();
  let top = 0;
  for (const stats of all) {
    for (const [key, value] of Object.entries(stats)) {
      if (typeof value === "number")
        merged[key] = ((merged[key] as number | undefined) ?? 0) + value;
      else if (Array.isArray(value)) {
        top = Math.max(top, value.length);
        for (const { country, visitors } of value as { country: string; visitors: number }[]) {
          countries.set(country, (countries.get(country) ?? 0) + visitors);
        }
        merged[key] = [];
      }
    }
  }
  for (const [key, value] of Object.entries(merged)) {
    if (Array.isArray(value)) {
      merged[key] = [...countries]
        .map(([country, visitors]) => ({ country, visitors }))
        .sort((a, b) => b.visitors - a.visitors || a.country.localeCompare(b.country))
        .slice(0, top);
    }
  }
  return merged;
};

export const startRouter = (options: RouterOptions) => {
  const servers = options.servers.map((server) => new URL(server).origin);
  if (!servers.length) throw new Error("At least one server is required.");
  const owners = slotOwners(servers);
  let statsCache: { expires: number; body: Promise<Record<string, unknown>> } | null = null;

  const clientIp = (request: Request, server: Server<Relay>) => {
    const header = options.clientIpHeader;
    const ip = header
      ? firstValue(request.headers.get(header))
      : server.requestIP(request)?.address;
    return ip || "unknown";
  };

  const serverFor = (url: URL, path: string, ip: string) => {
    const slot = routeOf(path);
    if (slot !== null) return owners[slot] as string;
    if (isAdmin(path)) return servers[adminServer(url, path) - 1] as string;
    return owners[slotOfKey(ip)] as string;
  };

  /** The server the dashboard is looking at, from 1; the first one for logins. */
  const adminServer = (url: URL, path: string) => {
    if (path === `${ADMIN_PATH}/login`) return 1;
    const server = Number(url.searchParams.get("server"));
    return Number.isSafeInteger(server) && server >= 1 && server <= servers.length ? server : 1;
  };

  const forwardedHeaders = (request: Request, url: URL, ip: string) => {
    const headers = new Headers(request.headers);
    for (const name of DROPPED_HEADERS) headers.delete(name);
    if (!options.clientIpHeader) for (const name of LOCATION_HEADERS) headers.delete(name);
    if (options.clientIpHeader) {
      headers.set(
        "x-forwarded-proto",
        request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1),
      );
      headers.set("x-forwarded-host", request.headers.get("x-forwarded-host") ?? url.host);
    } else {
      headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
      headers.set("x-forwarded-host", url.host);
    }
    headers.set("x-forwarded-for", ip);
    return headers;
  };

  const stats = () => {
    if (!statsCache || statsCache.expires < Date.now()) {
      statsCache = {
        expires: Date.now() + STATS_TTL_MS,
        body: Promise.all(
          servers.map(async (server) => {
            const response = await fetch(`${server}/stats.json`, {
              signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
            });
            if (!response.ok) throw new Error(`${server}/stats.json: ${response.status}`);
            return (await response.json()) as Record<string, unknown>;
          }),
        ).then(mergeStats),
      };
      statsCache.body.catch(() => (statsCache = null));
    }
    return statsCache.body;
  };

  return Bun.serve<Relay>({
    port: options.port,
    hostname: options.hostname,
    // Each server enforces its own limits.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    async fetch(request, server) {
      const url = new URL(request.url);
      const ip = clientIp(request, server);
      // Outside the base path, any server answers (with a 404).
      const path = sitePath(options.basePath ?? "", url.pathname) ?? "";
      if (path === "/stats.json" && request.method === "GET") {
        try {
          return Response.json(await stats(), {
            headers: { "Cache-Control": `public, max-age=${STATS_TTL_MS / 1000}` },
          });
        } catch (error) {
          logError("Stats failed", error);
          return unreachable();
        }
      }

      const target = new URL(`${url.pathname}${url.search}`, serverFor(url, path, ip));
      const headers = forwardedHeaders(request, url, ip);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
        const relay: Relay = { target: target.href, headers, pending: [] };
        if (server.upgrade(request, { data: relay })) return undefined;
        return Response.json({ error: "Expected a WebSocket upgrade." }, { status: 426 });
      }
      try {
        const response = await fetch(target, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
          // Passed on as the server sent it, compressed or not.
          decompress: false,
        });
        const relayed = new Response(response.body, response);
        // Which server answered, and how many there are, for the dashboard's
        // server picker. Only on answers it got by being logged in.
        if (isAdmin(path) && path !== `${ADMIN_PATH}/login` && response.ok) {
          relayed.headers.set("X-Kurobako-Server", String(adminServer(url, path)));
          relayed.headers.set("X-Kurobako-Servers", String(servers.length));
        }
        return relayed;
      } catch (error) {
        logError("Server unreachable", error, { server: target.origin, path: url.pathname });
        return unreachable();
      }
    },
    websocket: {
      open(socket: ServerWebSocket<Relay>) {
        const relay = socket.data;
        const upstream = new BunWebSocket(relay.target, { headers: relay.headers });
        relay.upstream = upstream;
        upstream.binaryType = "arraybuffer";
        upstream.addEventListener("open", () => {
          for (const message of relay.pending) upstream.send(message);
          relay.pending = [];
        });
        upstream.addEventListener("message", (event) =>
          socket.send(event.data as string | ArrayBuffer),
        );
        upstream.addEventListener("close", (event) =>
          socket.close(closeCode(event.code), event.reason),
        );
        upstream.addEventListener("error", () => socket.close(1011, "Server unreachable."));
      },
      message(socket, message) {
        const { upstream, pending } = socket.data;
        // Bun hands binary messages over as a Buffer, possibly on shared
        // memory, which a WebSocket does not send: a plain copy goes.
        const data = typeof message === "string" ? message : new Uint8Array(message);
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
        else pending.push(data);
      },
      close(socket) {
        socket.data.upstream?.close();
      },
    },
  });
};

if (import.meta.main) {
  if (!process.stdout.isTTY) printJsonLines();
  const env = process.env;
  const servers = (env.SERVERS ?? "")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  const router = startRouter({
    servers,
    port: Number(env.PORT || 3000),
    hostname: env.HOST || "0.0.0.0",
    clientIpHeader: env.CLIENT_IP_HEADER?.toLowerCase() || null,
    basePath: loadConfig(env).basePath,
  });
  console.info(`Routing ${router.url} to ${servers.join(", ")}`);
}
