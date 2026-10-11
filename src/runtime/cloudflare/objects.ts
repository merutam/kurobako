// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The namespace and hub cores as Durable Objects: SQLite storage, alarms and
// hibernatable WebSockets come from the object, files from R2.
import { DurableObject } from "cloudflare:workers";
import { loadConfig } from "../../config";
import type { Sql, SqlValue } from "../../core/host";
import { HUB_METHODS, type HubApi, HubCore } from "../../core/hub";
import { objectName } from "../../core/model";
import { LIVE, NAMESPACE_METHODS, NamespaceCore } from "../../core/namespace";
import type { AccessEvent } from "../../core/visits";
import { CLOUDFLARE_LIMITS } from "./limits";
import { r2Store } from "./r2";

/** There is exactly one hub. */
export const HUB_NAME = "hub";
/** A live upgrade's visit travels to the object in this header. */
export const VISIT_HEADER = "x-kurobako-visit";

const sqlOf = (storage: DurableObjectStorage): Sql => ({
  exec: <T>(query: string, ...params: SqlValue[]) =>
    storage.sql.exec(query, ...params).toArray() as T[],
});

export const hubOf = (env: Env) => env.HUB.getByName(HUB_NAME) as unknown as HubApi;

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the interface below declares what expose() defines.
export class NamespaceObject extends DurableObject<Env> {
  readonly core: NamespaceCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(LIVE.ping, LIVE.pong));
    const sql = sqlOf(ctx.storage);
    this.core = new NamespaceCore(loadConfig(env, CLOUDFLARE_LIMITS), {
      hasStorage: () =>
        sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").length > 0,
      sql: () => sql,
      deleteStorage: () => ctx.storage.deleteAll(),
      setAlarm: (time) => (time === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(time)),
      sockets: () => ctx.getWebSockets(),
      blobs: r2Store(env.BUCKET),
      hub: () => hubOf(env),
    });
  }

  alarm() {
    return this.core.alarm();
  }

  /**
   * A WebSocket upgrade, forwarded with the namespace in the query string.
   * Sockets hibernate between changes, so idle viewers cost nothing.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    if (!this.core.canWatch()) {
      return Response.json(
        { error: "Too many live connections. Try again later." },
        { status: 503 },
      );
    }
    const url = new URL(request.url);
    const ref = { space: url.searchParams.get("space"), name: url.searchParams.get("name") };
    if ((ref.space !== "plain" && ref.space !== "sealed") || !ref.name) {
      return new Response("Missing namespace.", { status: 400 });
    }
    const visit = request.headers.get(VISIT_HEADER);
    const snapshot = await this.core.watch(visit ? (JSON.parse(visit) as AccessEvent) : undefined);
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.send(snapshot);
    await this.core.watchersChanged();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    // 1005 ("no status") and 1006 ("abnormal") describe a close; they cannot be sent.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed on our side.
    }
    await this.core.watchersChanged(socket);
  }
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the interface below declares what expose() defines.
export class HubObject extends DurableObject<Env> {
  readonly core: HubCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new HubCore(loadConfig(env, CLOUDFLARE_LIMITS), {
      sql: sqlOf(ctx.storage),
      ensureAlarm: async (time) => {
        if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(time);
      },
      setAlarm: (time) => ctx.storage.setAlarm(time),
      cleanUpNamespace: (ref) => env.NAMESPACES.getByName(objectName(ref)).cleanUpIfEmpty(ref),
    });
  }

  alarm() {
    return this.core.alarm();
  }
}

/**
 * Each method a core offers to requests (NAMESPACE_METHODS, HUB_METHODS), on
 * its Durable Object, which RPC exposes: a call runs on the object's core.
 */
const expose = (object: { prototype: object }, methods: readonly string[]) => {
  for (const method of methods) {
    Object.defineProperty(object.prototype, method, {
      value(this: { core: Record<string, (...args: unknown[]) => unknown> }, ...args: unknown[]) {
        return this.core[method]?.(...args);
      },
      writable: true,
      configurable: true,
    });
  }
};
expose(NamespaceObject, NAMESPACE_METHODS);
expose(HubObject, HUB_METHODS);

// What expose() adds, for the types of the objects' RPC stubs.
export interface NamespaceObject extends Pick<NamespaceCore, (typeof NAMESPACE_METHODS)[number]> {}
export interface HubObject extends Pick<HubCore, (typeof HUB_METHODS)[number]> {}
