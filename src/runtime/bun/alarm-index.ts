// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Durable Objects keep their alarms across restarts; Bun's timers do not. This
// index, in the hub's database, lets a restart restore them without opening
// every namespace's database.
import type { Database } from "bun:sqlite";
import type { NamespaceRef } from "../../core/model";

export const createAlarmIndex = (db: Database) => {
  db.run(`CREATE TABLE IF NOT EXISTS namespace_alarms (
    space TEXT NOT NULL,
    name TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (space, name)
  ) WITHOUT ROWID`);

  /** null clears it. */
  const save = (ref: NamespaceRef, time: number | null) => {
    if (time === null) {
      db.query("DELETE FROM namespace_alarms WHERE space = ? AND name = ?").run(
        ref.space,
        ref.name,
      );
    } else {
      db.query("INSERT OR REPLACE INTO namespace_alarms (space, name, at) VALUES (?, ?, ?)").run(
        ref.space,
        ref.name,
        time,
      );
    }
  };

  const all = () =>
    db.query("SELECT space, name, at FROM namespace_alarms").all() as (NamespaceRef & {
      at: number;
    })[];

  return { save, all };
};
