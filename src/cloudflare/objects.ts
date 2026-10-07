// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The namespace and hub cores as Durable Objects: SQLite storage, alarms and
// hibernatable WebSockets come from the object, files from R2.
import { DurableObject } from "cloudflare:workers";
import { loadConfig } from "../config";
import { HubCore } from "../hub";
import { type NamespaceRef, objectName } from "../model";
import { type ItemRef, LIVE, NamespaceCore, type Restored, type SaveInput } from "../namespace";
import type { HubApi, Sql, SqlValue } from "../platform";
import type { AccessEvent } from "../request-info";
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

export class NamespaceObject extends DurableObject<Env> {
  private readonly core: NamespaceCore;

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

  list(visit?: AccessEvent) {
    return this.core.list(visit);
  }
  save(ref: NamespaceRef, input: SaveInput, burn: boolean, visit?: AccessEvent) {
    return this.core.save(ref, input, burn, visit);
  }
  readText(ref: ItemRef, visit?: AccessEvent) {
    return this.core.readText(ref, visit);
  }
  claimObject(ref: ItemRef, visit?: AccessEvent) {
    return this.core.claimObject(ref, visit);
  }
  peek(ref: ItemRef, visit?: AccessEvent) {
    return this.core.peek(ref, visit);
  }
  locate(ref: ItemRef, visit?: AccessEvent) {
    return this.core.locate(ref, visit);
  }
  rename(
    ref: ItemRef,
    change: { name: string } | { metadata: string },
    expected: string | null,
    visit?: AccessEvent,
  ) {
    return this.core.rename(ref, change, expected, visit);
  }
  replace(ref: ItemRef, input: SaveInput, expected: string, visit?: AccessEvent) {
    return this.core.replace(ref, input, expected, visit);
  }
  remove(ref: ItemRef, visit?: AccessEvent) {
    return this.core.remove(ref, visit);
  }
  accessLog(visit?: AccessEvent) {
    return this.core.accessLog(visit);
  }
  cleanUpIfEmpty(ref: NamespaceRef) {
    return this.core.cleanUpIfEmpty(ref);
  }
  restore(ref: NamespaceRef, items: Restored[]) {
    return this.core.restore(ref, items);
  }
  isLocked() {
    return this.core.isLocked();
  }
  checkWrite(verifier: string | null) {
    return this.core.checkWrite(verifier);
  }
  lock(ref: NamespaceRef, verifier: string, current: string | null, onlyEmpty: boolean) {
    return this.core.lock(ref, verifier, current, onlyEmpty);
  }
  unlock(verifier: string | null) {
    return this.core.unlock(verifier);
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

export class HubObject extends DurableObject<Env> {
  private readonly core: HubCore;

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
  reportNamespace(...args: Parameters<HubCore["reportNamespace"]>) {
    return this.core.reportNamespace(...args);
  }
  forgetNamespace(...args: Parameters<HubCore["forgetNamespace"]>) {
    return this.core.forgetNamespace(...args);
  }
  recordActivity(...args: Parameters<HubCore["recordActivity"]>) {
    return this.core.recordActivity(...args);
  }
  recordVisitor(...args: Parameters<HubCore["recordVisitor"]>) {
    return this.core.recordVisitor(...args);
  }
  createShare(...args: Parameters<HubCore["createShare"]>) {
    return this.core.createShare(...args);
  }
  extendShare(...args: Parameters<HubCore["extendShare"]>) {
    return this.core.extendShare(...args);
  }
  resolveShare(...args: Parameters<HubCore["resolveShare"]>) {
    return this.core.resolveShare(...args);
  }
  forgetShare(...args: Parameters<HubCore["forgetShare"]>) {
    return this.core.forgetShare(...args);
  }
  loginLockedOut(...args: Parameters<HubCore["loginLockedOut"]>) {
    return this.core.loginLockedOut(...args);
  }
  loginFailed(...args: Parameters<HubCore["loginFailed"]>) {
    return this.core.loginFailed(...args);
  }
  loginSucceeded(...args: Parameters<HubCore["loginSucceeded"]>) {
    return this.core.loginSucceeded(...args);
  }
  stats() {
    return this.core.stats();
  }
  overview() {
    return this.core.overview();
  }
  namespacesPage(...args: Parameters<HubCore["namespacesPage"]>) {
    return this.core.namespacesPage(...args);
  }
  allNamespaces() {
    return this.core.allNamespaces();
  }
  storedBytes() {
    return this.core.storedBytes();
  }
}
