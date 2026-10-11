// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { Sql } from "../host";

/** A view freezes its member IDs on rotation, not their live contents. */
export const VIEW_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS views (
  token TEXT PRIMARY KEY,
  view_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS view_entries (
  token TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  envelope TEXT,
  PRIMARY KEY (token, item_id)
)`,
];

export type ViewEntry = { id: string; envelope?: string };
export type ViewRecord = {
  token: string;
  viewId: string;
  createdAt: string;
  active: boolean;
};

type ViewRow = { token: string; view_id: string; created_at: string };
type EntryRow = { item_id: string; envelope: string | null };
const record = (row: ViewRow, activeToken: string | null): ViewRecord => ({
  token: row.token,
  viewId: row.view_id,
  createdAt: row.created_at,
  active: row.token === activeToken,
});

export class Views {
  constructor(private readonly sql: () => Sql) {}

  private activeToken(): string | null {
    return (
      this.sql().exec<{ value: string }>("SELECT value FROM meta WHERE key = 'active_view'")[0]
        ?.value ?? null
    );
  }

  active(): ViewRecord | null {
    const token = this.activeToken();
    if (!token) return null;
    const row = this.sql().exec<ViewRow>(
      "SELECT token, view_id, created_at FROM views WHERE token = ?",
      token,
    )[0];
    return row ? record(row, token) : null;
  }

  all(): ViewRecord[] {
    const activeToken = this.activeToken();
    return this.sql()
      .exec<ViewRow>("SELECT token, view_id, created_at FROM views ORDER BY created_at DESC")
      .map((row) => record(row, activeToken));
  }

  get(token: string): ViewRecord | null {
    const row = this.sql().exec<ViewRow>(
      "SELECT token, view_id, created_at FROM views WHERE token = ?",
      token,
    )[0];
    return row ? record(row, this.activeToken()) : null;
  }

  entries(token: string): ViewEntry[] {
    return this.sql()
      .exec<EntryRow>(
        "SELECT item_id, envelope FROM view_entries WHERE token = ? ORDER BY ordinal ASC",
        token,
      )
      .map((row) => ({ id: row.item_id, ...(row.envelope ? { envelope: row.envelope } : {}) }));
  }

  /** Called without an await between the queue insertion and this insertion. */
  append(token: string, id: string, envelope?: string): void {
    const ordinal =
      this.sql().exec<{ first: number | null }>(
        "SELECT MIN(ordinal) AS first FROM view_entries WHERE token = ?",
        token,
      )[0]?.first ?? 0;
    this.sql().exec(
      "INSERT INTO view_entries (token, item_id, ordinal, envelope) VALUES (?, ?, ?, ?)",
      token,
      id,
      ordinal - 1,
      envelope ?? null,
    );
  }

  /** Reorders the active view, without changing any frozen view. */
  moveToFront(token: string, id: string): void {
    const ordinal =
      this.sql().exec<{ first: number | null }>(
        "SELECT MIN(ordinal) AS first FROM view_entries WHERE token = ?",
        token,
      )[0]?.first ?? 0;
    this.sql().exec(
      "UPDATE view_entries SET ordinal = ? WHERE token = ? AND item_id = ?",
      ordinal - 1,
      token,
      id,
    );
  }

  /** A plain import needs no client-side envelopes, so it can join the active view. */
  syncPlain(token: string, ids: string[]): void {
    for (const [ordinal, id] of ids.entries()) {
      this.sql().exec(
        "INSERT OR IGNORE INTO view_entries (token, item_id, ordinal, envelope) VALUES (?, ?, ?, NULL)",
        token,
        id,
        ordinal,
      );
      this.sql().exec(
        "UPDATE view_entries SET ordinal = ? WHERE token = ? AND item_id = ?",
        ordinal,
        token,
        id,
      );
    }
  }

  rotate(token: string, viewId: string, items: ViewEntry[]): ViewRecord {
    const createdAt = new Date().toISOString();
    try {
      this.sql().exec(
        "INSERT INTO views (token, view_id, created_at) VALUES (?, ?, ?)",
        token,
        viewId,
        createdAt,
      );
      for (const [ordinal, item] of items.entries()) {
        this.sql().exec(
          "INSERT INTO view_entries (token, item_id, ordinal, envelope) VALUES (?, ?, ?, ?)",
          token,
          item.id,
          ordinal,
          item.envelope ?? null,
        );
      }
      // A failed insert above leaves the old active view untouched.
      this.sql().exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('active_view', ?)", token);
    } catch (error) {
      this.sql().exec("DELETE FROM view_entries WHERE token = ?", token);
      this.sql().exec("DELETE FROM views WHERE token = ?", token);
      throw error;
    }
    return { token, viewId, createdAt, active: true };
  }
}
