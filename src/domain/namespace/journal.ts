// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Work that must survive a failure or a restart, kept as keys in meta:
// storage reservations not yet reported to the hub, and object deletes not
// yet done. Written before the remote call, cleared after it succeeds.
import type { Sql } from "../host";

export class Journal {
  constructor(
    private readonly sql: () => Sql,
    private readonly prefix: string,
  ) {}

  add(key: string): void {
    this.sql().exec("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '')", this.prefix + key);
  }

  remove(key: string): void {
    this.sql().exec("DELETE FROM meta WHERE key = ?", this.prefix + key);
  }

  keys(): string[] {
    return this.sql()
      .exec<{ key: string }>("SELECT key FROM meta WHERE key LIKE ?", `${this.prefix}%`)
      .map(({ key }) => key.slice(this.prefix.length));
  }
}
