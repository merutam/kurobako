// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { Database } from "bun:sqlite";
import { logError } from "../log";
import type { Sql, SqlValue } from "../platform";

export const openDatabase = (path: string) => {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  return db;
};

export const sqlOf = (db: Database): Sql => ({
  exec: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[],
});

/** setTimeout cannot wait longer than this. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** One pending call at a time, like a Durable Object alarm (but not kept across restarts). */
export class Alarm {
  private timer: ReturnType<typeof setTimeout> | null = null;
  at: number | null = null;

  constructor(private readonly run: () => Promise<void>) {}

  set(time: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.at = time;
    if (time !== null) this.arm();
  }

  private arm(): void {
    const delay = Math.max(0, (this.at ?? 0) - Date.now());
    this.timer = setTimeout(
      () => {
        if (delay > MAX_TIMEOUT_MS) return this.arm();
        this.timer = null;
        this.at = null;
        this.run().catch((error: unknown) => logError("Alarm failed", error));
      },
      Math.min(delay, MAX_TIMEOUT_MS),
    );
  }
}
