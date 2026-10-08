// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A namespace's items: the table that holds them, newest first, and the rules
// for making and renaming one.
import { safeFileName, safeMediaName } from "../image";
import {
  defaultTextName,
  nameOf,
  newItemId,
  readLimitedItem,
  SEALED_METADATA_PATTERN,
  type StoredItem,
  TEXT_NAME_MAX_CHARS,
} from "../model";
import type { Sql } from "../platform";

/**
 * What to record for a new item. File contents never pass through here: the
 * request handler uploads them to the blob store and hands over the key.
 */
export type SaveInput = (
  | { kind: "text"; text: string; size: number }
  | { kind: "text"; preview: string; object: string; size: number }
  | {
      kind: "image" | "file";
      mime: string;
      filename: string;
      object: string;
      size: number;
      /** Whether the send named the file; a default name never renames an item. */
      named?: boolean;
    }
  | { kind: "sealed"; metadata: string; object: string; size: number }
) & {
  /** SHA-256 of the contents (hex), for plain items: the same contents move to the top. */
  sha256?: string;
};

/**
 * An item by its position in the queue (a number, 1 being the newest), or by
 * a string: its ID, or else its name (a file's name or a named text's), the
 * newest item of that name.
 */
export type ItemRef = string | number;

/** A new name: a plain item's, or an encrypted item's metadata sealed again. */
export type Rename = { name: string } | { metadata: string };

export const QUEUE_SCHEMA = `CREATE TABLE IF NOT EXISTS items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  expires_at INTEGER,
  data TEXT NOT NULL
)`;

const parse = (rows: { data: string }[]) => rows.map((row) => JSON.parse(row.data) as StoredItem);
const expiryOf = (item: StoredItem) => (item.expiresAt ? Date.parse(item.expiresAt) : null);

export class Queue {
  constructor(private readonly sql: () => Sql) {}

  /** Every item, newest first. */
  all(): StoredItem[] {
    return parse(this.sql().exec<{ data: string }>("SELECT data FROM items ORDER BY seq DESC"));
  }

  find(ref: ItemRef): StoredItem | null {
    if (typeof ref === "number") {
      const rows = this.sql().exec<{ data: string }>(
        "SELECT data FROM items ORDER BY seq DESC LIMIT 1 OFFSET ?",
        ref - 1,
      );
      return parse(rows)[0] ?? null;
    }
    const byId = this.sql().exec<{ data: string }>("SELECT data FROM items WHERE id = ?", ref);
    if (byId.length) return parse(byId)[0] ?? null;
    // A name, exactly; or else the start of one, ignoring case (newest first).
    const items = this.all();
    const start = ref.toLowerCase();
    return (
      items.find((item) => nameOf(item) === ref) ??
      items.find((item) => nameOf(item)?.toLowerCase().startsWith(start)) ??
      null
    );
  }

  /** Where an item stands: 1 for the newest. */
  position(id: string): number {
    const [row] = this.sql().exec<{ position: number }>(
      "SELECT COUNT(*) AS position FROM items WHERE seq >= (SELECT seq FROM items WHERE id = ?)",
      id,
    );
    return row?.position ?? 1;
  }

  /** When the newest item was sent, in milliseconds; 0 when there is none. */
  newestTime(): number {
    const [row] = this.sql().exec<{ data: string }>(
      "SELECT data FROM items ORDER BY seq DESC LIMIT 1",
    );
    return row ? Date.parse((JSON.parse(row.data) as StoredItem).createdAt) : 0;
  }

  /** An ID no item here has. */
  freshId(): string {
    let id = newItemId();
    while (this.find(id)) id = newItemId();
    return id;
  }

  /** The same contents already here, to move instead of storing them twice. */
  sameContents(kind: StoredItem["kind"], sha256: string): StoredItem | null {
    return (
      this.all().find(
        (item) => !readLimitedItem(item) && item.kind === kind && item.sha256 === sha256,
      ) ?? null
    );
  }

  /** Adds an item as the newest (an item already here moves to the top). */
  push(item: StoredItem): void {
    this.remove(item.id);
    this.sql().exec(
      "INSERT INTO items (id, expires_at, data) VALUES (?, ?, ?)",
      item.id,
      expiryOf(item),
      JSON.stringify(item),
    );
  }

  /**
   * Puts the queue in order of when each item was sent, as after restoring
   * older items: they were added last, but belong further down.
   */
  sortByDate(): void {
    // Stable, oldest first: items sent in the same millisecond keep their order.
    const items = this.all()
      .reverse()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.sql().exec("DELETE FROM items");
    for (const item of items) {
      this.sql().exec(
        "INSERT INTO items (id, expires_at, data) VALUES (?, ?, ?)",
        item.id,
        expiryOf(item),
        JSON.stringify(item),
      );
    }
  }

  /** Writes an item's new details, keeping its place. */
  update(item: StoredItem): void {
    this.sql().exec("UPDATE items SET data = ? WHERE id = ?", JSON.stringify(item), item.id);
  }

  remove(id: string): void {
    this.sql().exec("DELETE FROM items WHERE id = ?", id);
  }

  /** Takes out the items past `max`, oldest first out, and returns them. */
  trimTo(max: number): StoredItem[] {
    const extra = parse(
      this.sql().exec<{ data: string }>(
        "SELECT data FROM items ORDER BY seq DESC LIMIT -1 OFFSET ?",
        max,
      ),
    );
    for (const item of extra) this.remove(item.id);
    return extra;
  }

  /** Takes out the items expired by `now`, and returns them. */
  takeExpired(now: number): StoredItem[] {
    const expired = parse(
      this.sql().exec<{ data: string }>(
        "SELECT data FROM items WHERE expires_at IS NOT NULL AND expires_at <= ?",
        now,
      ),
    );
    if (expired.length) {
      this.sql().exec("DELETE FROM items WHERE expires_at IS NOT NULL AND expires_at <= ?", now);
    }
    return expired;
  }

  /** When the next item expires, or null if none does. */
  nextExpiry(): number | null {
    const [row] = this.sql().exec<{ next: number | null }>(
      "SELECT MIN(expires_at) AS next FROM items",
    );
    return row?.next ?? null;
  }
}

/** A new item from what was sent. */
export const newItem = (
  id: string,
  input: SaveInput,
  burn: boolean,
  createdAt: string,
  expiresAt: string | null,
  reads: number | null = null,
): StoredItem => {
  const limited = burn || reads !== null;
  const sha256 = limited ? undefined : input.sha256;
  const common = {
    id,
    createdAt,
    expiresAt,
    ...(burn || reads === 1 ? { burn: true as const } : {}),
    ...(reads !== null && reads > 1 ? { readsLeft: reads } : {}),
    ...(sha256 ? { sha256 } : {}),
  };
  if (input.kind === "text") {
    const start = "text" in input ? input.text : input.preview;
    return {
      ...common,
      kind: "text",
      mime: "text/plain; charset=utf-8",
      size: input.size,
      ...("text" in input
        ? { text: input.text }
        : { object: input.object, ...(limited ? {} : { preview: input.preview }) }),
      // Its start names it, which would give away a burn-after-reading text.
      ...(limited ? {} : { name: defaultTextName(start) }),
    };
  }
  if (input.kind === "sealed") {
    return {
      ...common,
      kind: "sealed",
      metadata: input.metadata,
      object: input.object,
      size: input.size,
    };
  }
  return {
    ...common,
    kind: input.kind,
    mime: input.mime,
    filename: input.filename,
    object: input.object,
    size: input.size,
  };
};

/**
 * A text with its contents replaced, as `input` brings them, keeping its ID,
 * dates, expiry and share link. A plain text named by its start is named by
 * the new start; one named by hand keeps its name. An encrypted item takes
 * a new body and metadata under the same wrapped key (its client sealed the
 * contents under a new revision). Files and burn-after-reading items stay as
 * sent.
 */
export const replacedItem = (
  item: StoredItem,
  input: SaveInput,
  updatedAt: string,
): StoredItem | { error: string } => {
  if (readLimitedItem(item)) return { error: "An item with limited reads cannot be edited." };
  if (item.kind === "sealed") {
    if (input.kind !== "sealed" || !SEALED_METADATA_PATTERN.test(input.metadata)) {
      return { error: "Missing or invalid X-Sealed-Metadata header." };
    }
    if (input.metadata.split(".")[0] !== item.metadata.split(".")[0]) {
      return { error: "The item's key cannot change." };
    }
  } else if (item.kind !== "text" || input.kind !== "text") {
    return { error: "Only texts can be edited." };
  }
  const replaced = newItem(item.id, input, false, item.createdAt, item.expiresAt);
  if (item.kind === "text" && replaced.kind === "text") {
    const start = "text" in item ? item.text : (item.preview ?? "");
    const byHand = item.name !== undefined && item.name !== defaultTextName(start);
    if (byHand) replaced.name = item.name;
  }
  return { ...replaced, updatedAt };
};

/**
 * An item under a new name. A plain item takes `name`: a file or image gets
 * it as its file name (an image keeps the extension of its real type), a text
 * as its name, and an empty name gives a text back its default, the start of
 * its text. An encrypted item takes new `metadata`, sealed again by the client
 * with the item's own key, so the wrapped key must stay the same.
 */
export const renamedItem = (item: StoredItem, change: Rename): StoredItem | { error: string } => {
  if (item.kind === "sealed") {
    if (!("metadata" in change) || !SEALED_METADATA_PATTERN.test(change.metadata)) {
      return { error: "Missing or invalid X-Sealed-Metadata header." };
    }
    if (change.metadata.split(".")[0] !== item.metadata.split(".")[0]) {
      return { error: "The item's key cannot change." };
    }
    return { ...item, metadata: change.metadata };
  }
  if (!("name" in change)) return { error: "Send the new name." };
  const name = change.name.replace(/\s+/g, " ").trim();
  if (item.kind === "text") {
    const { name: _old, ...rest } = item;
    const fallback = readLimitedItem(item)
      ? ""
      : defaultTextName("text" in item ? item.text : (item.preview ?? ""));
    const chosen = name ? name.slice(0, TEXT_NAME_MAX_CHARS) : fallback;
    return chosen ? { ...rest, name: chosen } : rest;
  }
  if (!name) return { error: "A file needs a name." };
  return {
    ...item,
    // Images and videos keep the extension of what they are.
    filename:
      item.kind === "image" || item.mime.startsWith("video/")
        ? safeMediaName(name, item.filename.split(".").pop() ?? "bin")
        : safeFileName(name),
  };
};
