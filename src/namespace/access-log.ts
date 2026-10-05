// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Who used a namespace: one row per address, kept as long as the namespace.
import type { Sql } from "../platform";
import type { AccessEvent, AccessLogEntry } from "../request-info";

const MAX_ENTRIES = 5_000;

export const ACCESS_LOG_SCHEMA = `CREATE TABLE IF NOT EXISTS access_log (
  ip TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  data TEXT NOT NULL
)`;

export class AccessLog {
  constructor(private readonly sql: () => Sql) {}

  /** One more visit from an address: its counts and latest details. */
  record(event: AccessEvent): void {
    const now = new Date();
    const [previous] = this.sql().exec<{ data: string }>(
      "SELECT data FROM access_log WHERE ip = ?",
      event.ip,
    );
    const before = previous ? (JSON.parse(previous.data) as AccessLogEntry) : null;
    const entry: AccessLogEntry = {
      ip: event.ip,
      firstSeenAt: before?.firstSeenAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
      hits: (before?.hits ?? 0) + 1,
      lastMethod: event.lastMethod.slice(0, 12),
      lastPath: event.lastPath.slice(0, 200),
      userAgent: event.userAgent.slice(0, 300) || before?.userAgent || "",
      country: event.country?.slice(0, 8) || before?.country || null,
      region: event.region?.slice(0, 80) || before?.region || null,
      city: event.city?.slice(0, 80) || before?.city || null,
    };
    this.sql().exec(
      "INSERT OR REPLACE INTO access_log (ip, last_seen, data) VALUES (?, ?, ?)",
      entry.ip,
      now.getTime(),
      JSON.stringify(entry),
    );
    // Only a new address can push the log over its cap.
    if (!before) {
      this.sql().exec(
        `DELETE FROM access_log WHERE ip IN (
          SELECT ip FROM access_log ORDER BY last_seen DESC LIMIT -1 OFFSET ?
        )`,
        MAX_ENTRIES,
      );
    }
  }

  /** Every address, the most recent first. */
  entries(): AccessLogEntry[] {
    return this.sql()
      .exec<{ data: string }>("SELECT data FROM access_log ORDER BY last_seen DESC")
      .map((row) => JSON.parse(row.data) as AccessLogEntry);
  }
}
