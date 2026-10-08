// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { AppConfig } from "./config";
import { logError } from "./log";
import { type NamespaceRef, objectName, SHARE_TOKEN_BYTES } from "./model";
import type { Sql, SqlValue } from "./platform";
import { slotOf, slotPrefix } from "./routing";

/** What the public stats count. Never tied to a namespace or a visitor. */
export const ACTIVITY_EVENTS = ["sentText", "sentFile", "sentEncrypted", "openedOnce"] as const;
export type ActivityEvent = (typeof ACTIVITY_EVENTS)[number];
type ActivityCounts = Record<ActivityEvent, number>;

export type PageQuery = { offset: number; limit: number; search?: string };
export type Page<T> = { total: number; offset: number; limit: number; items: T[] };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** The stats show at most 7 days of activity and 24 hours of visitors. */
const ACTIVITY_RETENTION_DAYS = 7;
const VISITOR_RETENTION_MS = DAY_MS;
/** A visitor seen again within this time is not rewritten. */
const VISITOR_REFRESH_MS = 30 * MINUTE_MS;
const TOP_COUNTRIES = 5;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * MINUTE_MS;
/** Pruning and the empty-namespace sweep run on this alarm, not on every write. */
const HOUSEKEEPING_MS = HOUR_MS;
/** Namespaces asked to clean up per sweep; a full batch sweeps again soon. */
const SWEEP_BATCH = 50;

const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/** What the hub needs from its platform. */
export interface HubHost {
  sql: Sql;
  /** Schedules alarm() unless it is already scheduled. */
  ensureAlarm(time: number): Promise<void>;
  /** Schedules alarm(), replacing any earlier time. */
  setAlarm(time: number): Promise<void>;
  /** Asks a namespace to delete itself if it is still empty. */
  cleanUpNamespace(ref: NamespaceRef): Promise<void>;
}

/**
 * Site-wide state, one instance per deployment: namespace sizes, daily
 * activity, recent visitors, share links and failed admin logins. Only
 * aggregates leave through stats(); names and IPs are for the admin.
 */
export class HubCore {
  private readonly sql: Sql;

  constructor(
    private readonly config: AppConfig,
    private readonly host: HubHost,
  ) {
    this.sql = host.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS namespaces (
        space TEXT NOT NULL,
        name TEXT NOT NULL,
        items INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        connections INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (space, name)
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS activity (
        day TEXT NOT NULL,
        event TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (day, event)
      )`,
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS visitors (ip TEXT PRIMARY KEY, country TEXT, last_seen INTEGER NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS login_failures (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)",
    );
    // Item IDs are unique within their namespace only, so a link is per
    // namespace and item.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS item_shares (
        token TEXT PRIMARY KEY,
        space TEXT NOT NULL,
        name TEXT NOT NULL,
        item_id TEXT NOT NULL,
        expires_at INTEGER,
        UNIQUE (space, name, item_id)
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS namespace_views (
        token TEXT PRIMARY KEY,
        space TEXT NOT NULL,
        name TEXT NOT NULL
      )`,
    );
  }

  /** The `total` column of a query's single row. */
  private count(query: string, ...params: SqlValue[]): number {
    return this.sql.exec<{ total: number }>(query, ...params)[0]?.total ?? 0;
  }

  /** Housekeeping runs hourly while there is anything to keep tidy. */
  private ensureAlarm(): Promise<void> {
    return this.host.ensureAlarm(Date.now() + HOUSEKEEPING_MS);
  }

  // --- Writes -----------------------------------------------------------

  async reportNamespace(
    ref: NamespaceRef,
    counts: { items: number; bytes: number; connections: number },
  ): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO namespaces (space, name, items, bytes, connections, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ref.space,
      ref.name,
      counts.items,
      counts.bytes,
      counts.connections,
      Date.now(),
    );
    await this.ensureAlarm();
  }

  /** After a restart, which drops every live connection. */
  async resetConnections(): Promise<void> {
    this.sql.exec("UPDATE namespaces SET connections = 0 WHERE connections > 0");
  }

  /** A namespace that cleaned itself up: drop it from the listing and its share links. */
  async forgetNamespace(ref: NamespaceRef): Promise<void> {
    this.sql.exec("DELETE FROM namespaces WHERE space = ? AND name = ?", ref.space, ref.name);
    this.sql.exec("DELETE FROM item_shares WHERE space = ? AND name = ?", ref.space, ref.name);
    this.sql.exec("DELETE FROM namespace_views WHERE space = ? AND name = ?", ref.space, ref.name);
  }

  async recordActivity(event: ActivityEvent): Promise<void> {
    this.sql.exec(
      `INSERT INTO activity (day, event, count) VALUES (?, ?, 1)
       ON CONFLICT (day, event) DO UPDATE SET count = count + 1`,
      dayKey(Date.now()),
      event,
    );
    await this.ensureAlarm();
  }

  /** One page view. Only rewrites a visitor not seen for a while. */
  async recordVisitor(ip: string, country: string | null): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO visitors (ip, country, last_seen) VALUES (?, ?, ?)
       ON CONFLICT (ip) DO UPDATE SET country = excluded.country, last_seen = excluded.last_seen
       WHERE last_seen < ?`,
      ip,
      country,
      now,
      now - VISITOR_REFRESH_MS,
    );
    await this.ensureAlarm();
  }

  /**
   * Hourly: prunes old rows and asks namespaces listed as empty for longer
   * than EMPTY_NAMESPACE_TTL_SECONDS to clean up, a safety net for their own
   * cleanup.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec("DELETE FROM visitors WHERE last_seen <= ?", now - VISITOR_RETENTION_MS);
    this.sql.exec(
      "DELETE FROM activity WHERE day < ?",
      dayKey(now - (ACTIVITY_RETENTION_DAYS - 1) * DAY_MS),
    );
    this.sql.exec("DELETE FROM login_failures WHERE reset_at <= ?", now);
    this.pruneShares();

    const stale = this.sql.exec<{ space: NamespaceRef["space"]; name: string }>(
      `SELECT space, name FROM namespaces
         WHERE items = 0 AND connections = 0 AND updated_at <= ? LIMIT ?`,
      now - this.config.emptyNamespaceTtlMs,
      SWEEP_BATCH,
    );
    for (const ref of stale) {
      try {
        await this.host.cleanUpNamespace(ref);
      } catch (error) {
        logError("Namespace cleanup failed", error, { namespace: objectName(ref) });
      }
    }

    const remaining = this.count(
      `SELECT (SELECT COUNT(*) FROM namespaces) + (SELECT COUNT(*) FROM visitors)
              + (SELECT COUNT(*) FROM activity) + (SELECT COUNT(*) FROM item_shares)
              + (SELECT COUNT(*) FROM login_failures)
              + (SELECT COUNT(*) FROM namespace_views) AS total`,
    );
    if (remaining) {
      await this.host.setAlarm(now + (stale.length === SWEEP_BATCH ? MINUTE_MS : HOUSEKEEPING_MS));
    }
  }

  // --- Share links ------------------------------------------------------

  /** One token per item: sharing the same item twice gives the same link. */
  private createShareRow(ref: NamespaceRef, itemId: string, expiresAt: string | null): string {
    const existing = this.sql.exec<{ token: string }>(
      "SELECT token FROM item_shares WHERE space = ? AND name = ? AND item_id = ?",
      ref.space,
      ref.name,
      itemId,
    )[0];
    if (existing) return existing.token;

    const bytes = crypto.getRandomValues(new Uint8Array(SHARE_TOKEN_BYTES));
    const token =
      slotPrefix(slotOf(ref)) +
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    this.sql.exec(
      "INSERT INTO item_shares (token, space, name, item_id, expires_at) VALUES (?, ?, ?, ?, ?)",
      token,
      ref.space,
      ref.name,
      itemId,
      expiresAt ? Date.parse(expiresAt) : null,
    );
    return token;
  }

  async createShare(ref: NamespaceRef, itemId: string, expiresAt: string | null): Promise<string> {
    const token = this.createShareRow(ref, itemId, expiresAt);
    await this.ensureAlarm();
    return token;
  }

  /** A view index needs many links; one hub RPC is cheaper than one per item. */
  async createShares(
    ref: NamespaceRef,
    items: { id: string; expiresAt: string | null }[],
  ): Promise<string[]> {
    const tokens = items.map((item) => this.createShareRow(ref, item.id, item.expiresAt));
    if (tokens.length) await this.ensureAlarm();
    return tokens;
  }

  /** An item sent again lives longer, and so does its share link. */
  async extendShare(ref: NamespaceRef, itemId: string, expiresAt: string | null): Promise<void> {
    this.sql.exec(
      "UPDATE item_shares SET expires_at = ? WHERE space = ? AND name = ? AND item_id = ?",
      expiresAt ? Date.parse(expiresAt) : null,
      ref.space,
      ref.name,
      itemId,
    );
  }

  async resolveShare(token: string): Promise<{ ref: NamespaceRef; itemId: string } | null> {
    const row = this.sql.exec<{
      space: NamespaceRef["space"];
      name: string;
      item_id: string;
      expires_at: number | null;
    }>("SELECT space, name, item_id, expires_at FROM item_shares WHERE token = ?", token)[0];
    if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) return null;
    return { ref: { space: row.space, name: row.name }, itemId: row.item_id };
  }

  /** For links whose item is gone (deleted, pushed out of the queue, read once). */
  async forgetShare(token: string): Promise<void> {
    this.sql.exec("DELETE FROM item_shares WHERE token = ?", token);
  }

  /** The opaque view route resolves to its source only inside the server. */
  async registerView(ref: NamespaceRef, token: string): Promise<void> {
    this.sql.exec(
      "INSERT INTO namespace_views (token, space, name) VALUES (?, ?, ?)",
      token,
      ref.space,
      ref.name,
    );
    await this.ensureAlarm();
  }

  async resolveView(token: string): Promise<NamespaceRef | null> {
    const row = this.sql.exec<{ space: NamespaceRef["space"]; name: string }>(
      "SELECT space, name FROM namespace_views WHERE token = ?",
      token,
    )[0];
    return row ?? null;
  }

  /** A rotation that lost its compare-and-swap never publishes its route. */
  async forgetView(token: string): Promise<void> {
    this.sql.exec("DELETE FROM namespace_views WHERE token = ?", token);
  }

  private pruneShares(): void {
    this.sql.exec(
      "DELETE FROM item_shares WHERE expires_at IS NOT NULL AND expires_at <= ?",
      Date.now(),
    );
  }

  // --- Admin login lockout ---------------------------------------------

  async loginLockedOut(ip: string): Promise<boolean> {
    const row = this.sql.exec<{ count: number; reset_at: number }>(
      "SELECT count, reset_at FROM login_failures WHERE ip = ?",
      ip,
    )[0];
    return Boolean(row && row.reset_at > Date.now() && row.count >= MAX_FAILED_LOGINS);
  }

  async loginFailed(ip: string): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO login_failures (ip, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT (ip) DO UPDATE SET
         count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
         reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END`,
      ip,
      now + LOCKOUT_MS,
      now,
      now,
    );
    await this.ensureAlarm();
  }

  async loginSucceeded(ip: string): Promise<void> {
    this.sql.exec("DELETE FROM login_failures WHERE ip = ?", ip);
  }

  // --- Reads ------------------------------------------------------------

  private activityTotals(days: number): ActivityCounts {
    const totals = Object.fromEntries(ACTIVITY_EVENTS.map((event) => [event, 0])) as ActivityCounts;
    const rows = this.sql.exec<{ event: ActivityEvent; total: number }>(
      "SELECT event, SUM(count) AS total FROM activity WHERE day >= ? GROUP BY event",
      dayKey(Date.now() - (days - 1) * DAY_MS),
    );
    for (const row of rows) if (row.event in totals) totals[row.event] = row.total;
    return totals;
  }

  private totals() {
    const rows = this.sql.exec<{
      space: string;
      namespaces: number;
      items: number;
      bytes: number;
      connections: number;
    }>(
      `SELECT space, COUNT(*) AS namespaces, SUM(items) AS items, SUM(bytes) AS bytes,
                SUM(connections) AS connections
         FROM namespaces GROUP BY space`,
    );
    const of = (space: string) =>
      rows.find((row) => row.space === space) ?? {
        namespaces: 0,
        items: 0,
        bytes: 0,
        connections: 0,
      };
    return { plain: of("plain"), sealed: of("sealed") };
  }

  /** Public, aggregate-only numbers for the home page. */
  async stats() {
    const since = Date.now() - DAY_MS;
    const { plain, sealed } = this.totals();
    const today = this.activityTotals(1);
    const week = this.activityTotals(7);
    const sent = (counts: ActivityCounts) =>
      counts.sentText + counts.sentFile + counts.sentEncrypted;
    const visitors = this.count(
      "SELECT COUNT(*) AS total FROM visitors WHERE last_seen > ?",
      since,
    );
    const topCountries = this.sql.exec<{ country: string; visitors: number }>(
      `SELECT country, COUNT(*) AS visitors FROM visitors
         WHERE last_seen > ? AND country IS NOT NULL
         GROUP BY country ORDER BY visitors DESC LIMIT ?`,
      since,
      TOP_COUNTRIES,
    );

    return {
      totalItems: plain.items + sealed.items,
      encryptedItems: sealed.items,
      sentToday: sent(today),
      sentLast7Days: sent(week),
      openedOnceLast7Days: week.openedOnce,
      visitorsLast24h: visitors,
      topCountriesLast24h: topCountries,
      liveConnections: plain.connections + sealed.connections,
    };
  }

  async overview() {
    const { plain, sealed } = this.totals();
    return {
      storedBytes: plain.bytes + sealed.bytes,
      liveConnections: plain.connections + sealed.connections,
      activityToday: this.activityTotals(1),
      activityLast7Days: this.activityTotals(7),
      namespaces: { count: plain.namespaces },
      encryptedNamespaces: { count: sealed.namespaces, items: sealed.items },
    };
  }

  /** What every item together takes, in bytes. */
  async storedBytes(): Promise<number> {
    return this.count("SELECT COALESCE(SUM(bytes), 0) AS total FROM namespaces");
  }

  /** Every namespace this hub knows, plain and encrypted: what a full backup covers. */
  async allNamespaces(): Promise<NamespaceRef[]> {
    return this.sql.exec<NamespaceRef>("SELECT space, name FROM namespaces ORDER BY space, name");
  }

  async namespacesPage(query: PageQuery): Promise<Page<{ name: string; items: number }>> {
    const search = (query.search ?? "").toLowerCase();
    const total = this.count(
      "SELECT COUNT(*) AS total FROM namespaces WHERE space = 'plain' AND instr(name, ?) > 0",
      search,
    );
    const items = this.sql.exec<{ name: string; items: number }>(
      `SELECT name, items FROM namespaces WHERE space = 'plain' AND instr(name, ?) > 0
         ORDER BY items DESC, name LIMIT ? OFFSET ?`,
      search,
      query.limit,
      query.offset,
    );
    return { total, offset: query.offset, limit: query.limit, items };
  }
}
