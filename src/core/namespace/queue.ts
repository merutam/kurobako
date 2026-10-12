// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A namespace's items, newest first, and the rules for making and renaming them.

import { BUNDLE_MIME } from "../../client/shared/bundle.js";
import type { Sql } from "../host";
import { safeFileName, safeMediaName } from "../media";
import {
  defaultTextName,
  nameOf,
  newItemId,
  readLimitedItem,
  SEALED_METADATA_PATTERN,
  type StoredItem,
  TEXT_NAME_MAX_CHARS,
} from "../model";

/** File contents never pass through here: only their blob key. */
export type SaveInput = (
  | { kind: "text"; text: string; size: number; name?: string }
  | { kind: "text"; preview: string; object: string; size: number; name?: string }
  | {
      kind: "image" | "file";
      mime: string;
      filename: string;
      object: string;
      size: number;
      /** A default name never renames an item. */
      named?: boolean;
    }
  | { kind: "sealed"; metadata: string; object: string; size: number }
) & {
  /** Plain items only: ciphertext never matches. */
  sha256?: string;
};

/**
 * A number is a position (1 is the newest); a string an ID, else the newest item with that name.
 */
export type ItemRef = string | number;

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
    // An exact name first; else a prefix, ignoring case, newest first.
    const items = this.all();
    const start = ref.toLowerCase();
    return (
      items.find((item) => nameOf(item) === ref) ??
      items.find((item) => nameOf(item)?.toLowerCase().startsWith(start)) ??
      null
    );
  }

  position(id: string): number {
    const [row] = this.sql().exec<{ position: number }>(
      "SELECT COUNT(*) AS position FROM items WHERE seq >= (SELECT seq FROM items WHERE id = ?)",
      id,
    );
    return row?.position ?? 1;
  }

  newestTime(): number {
    const [row] = this.sql().exec<{ data: string }>(
      "SELECT data FROM items ORDER BY seq DESC LIMIT 1",
    );
    return row ? Date.parse((JSON.parse(row.data) as StoredItem).createdAt) : 0;
  }

  freshId(): string {
    let id = newItemId();
    while (this.find(id)) id = newItemId();
    return id;
  }

  sameContents(kind: StoredItem["kind"], sha256: string): StoredItem | null {
    return (
      this.all().find(
        (item) => !readLimitedItem(item) && item.kind === kind && item.sha256 === sha256,
      ) ?? null
    );
  }

  push(item: StoredItem): void {
    this.remove(item.id);
    this.sql().exec(
      "INSERT INTO items (id, expires_at, data) VALUES (?, ?, ?)",
      item.id,
      expiryOf(item),
      JSON.stringify(item),
    );
  }

  /** Restored items are added last but may belong further down. */
  sortByDate(): void {
    // Stable: items sent in the same millisecond keep their order.
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

  update(item: StoredItem): void {
    this.sql().exec("UPDATE items SET data = ? WHERE id = ?", JSON.stringify(item), item.id);
  }

  remove(id: string): void {
    this.sql().exec("DELETE FROM items WHERE id = ?", id);
  }

  /** Returned, so the caller can delete their files. */
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

  /** Returned, so the caller can delete their files. */
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

  nextExpiry(): number | null {
    const [row] = this.sql().exec<{ next: number | null }>(
      "SELECT MIN(expires_at) AS next FROM items",
    );
    return row?.next ?? null;
  }
}

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
      // Hidden for limited reads, whose contents must stay unseen.
      ...(limited ? {} : { name: input.name ?? defaultTextName(start) }),
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
 * Keeps ID, dates, expiry and share link. A text named by hand keeps its name.
 * An encrypted item keeps its wrapped key; its client sealed a new revision.
 * Only bundles take another bundle; other files and limited items stay as sent.
 */
const isBundleItem = (item: StoredItem | SaveInput) =>
  item.kind === "file" && "mime" in item && item.mime === BUNDLE_MIME;

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
  } else {
    const text = item.kind === "text" && input.kind === "text";
    const bundle = isBundleItem(item) && isBundleItem(input);
    if (!text && !bundle) {
      return { error: "Only texts and bundles can be edited, each into its own kind." };
    }
  }
  const replaced = newItem(item.id, input, false, item.createdAt, item.expiresAt);
  if (item.kind === "text" && replaced.kind === "text") {
    const start = "text" in item ? item.text : (item.preview ?? "");
    const byHand = item.name !== undefined && item.name !== defaultTextName(start);
    if (byHand) replaced.name = item.name;
  }
  // A bundle sent again without a name keeps its own.
  if (replaced.kind === "file" && item.kind === "file" && input.kind === "file" && !input.named) {
    replaced.filename = item.filename;
  }
  return { ...replaced, updatedAt };
};

/**
 * An empty name gives a text back its default. An encrypted item's metadata is
 * sealed with its own key, so the wrapped key must stay the same.
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
    // So they still open with the right app.
    filename:
      item.kind === "image" || item.mime.startsWith("video/")
        ? safeMediaName(name, item.filename.split(".").pop() ?? "bin")
        : safeFileName(name),
  };
};
