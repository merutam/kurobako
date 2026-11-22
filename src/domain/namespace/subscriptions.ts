// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The devices that follow a namespace, and what a new item tells them.
import type { Sql } from "../host";
import { type NamespaceRef, readLimitedItem, type StoredItem } from "../model";
import { PUSH_PREVIEW_CHARS, type PushMessage, type PushTarget, skipIdOf } from "../push";

export class PushSubscriptions {
  constructor(private readonly sql: () => Sql) {}

  /** The newest `max` are kept. */
  async add(target: PushTarget, max: number): Promise<void> {
    this.sql().exec(
      "INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, skip_id, created_at) VALUES (?, ?, ?, ?, ?)",
      target.endpoint,
      target.p256dh,
      target.auth,
      await skipIdOf(target.endpoint),
      Date.now(),
    );
    this.sql().exec(
      `DELETE FROM push_subscriptions WHERE endpoint NOT IN
        (SELECT endpoint FROM push_subscriptions ORDER BY created_at DESC LIMIT ?)`,
      max,
    );
  }

  remove(endpoint: string): void {
    this.sql().exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
  }

  /** Every device but the sending one (`skip`). */
  targets(skip: string | null): PushTarget[] {
    return this.sql()
      .exec<PushTarget & { skip_id: string }>(
        "SELECT endpoint, p256dh, auth, skip_id FROM push_subscriptions",
      )
      .filter(({ skip_id }) => skip_id !== skip)
      .map(({ skip_id: _, ...target }) => target);
  }
}

/** Encrypted or read-once items show nothing of their contents. */
export const pushMessageOf = (ref: NamespaceRef, item: StoredItem): PushMessage => {
  const start = "text" in item ? item.text : "preview" in item ? item.preview : undefined;
  const preview =
    readLimitedItem(item) || item.kind === "sealed"
      ? undefined
      : item.kind === "text"
        ? start?.replace(/\s+/g, " ").trim().slice(0, PUSH_PREVIEW_CHARS)
        : item.filename;
  return {
    space: ref.space,
    name: ref.name,
    id: item.id,
    kind: item.kind === "sealed" ? "item" : item.kind,
    ...(preview ? { preview } : {}),
  };
};
