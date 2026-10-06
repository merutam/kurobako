// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// One namespace: what it does with its queue (queue.ts) and access log
// (access-log.ts), its expiry and cleanup timers, its live viewers and what it
// tells the hub.
import type { AppConfig } from "../config";
import {
  hasObject,
  type InlineTextItem,
  type NamespaceRef,
  type ObjectItem,
  type StoredItem,
  summaryItem,
} from "../model";
import type { BlobStore, HubApi, LiveSocket, Sql } from "../platform";
import type { AccessEvent, AccessLogEntry } from "../request-info";
import { ACCESS_LOG_SCHEMA, AccessLog } from "./access-log";
import {
  type ItemRef,
  newItem,
  QUEUE_SCHEMA,
  Queue,
  type Rename,
  renamedItem,
  replacedItem,
  type SaveInput,
} from "./queue";

export type { ItemRef, Rename, SaveInput };

/**
 * Whether a write may go: "open" (the namespace is not locked), "ok" (locked,
 * and the key is its write key), "missing" or "wrong" (locked, and it is not).
 */
export type WriteCheck = "open" | "ok" | "missing" | "wrong";

/** What a lock did: "locked", or why not: a plain namespace locks only empty. */
export type LockResult = "locked" | "not-empty" | "wrong";

/** What a send did: a new item, or the same contents already there, moved to the top. */
export type Saved = { item: StoredItem; existing: boolean };

/** An item from a backup: what to store, and the details it had. */
export type Restored = {
  input: SaveInput;
  id: string;
  createdAt: string;
  /** Last content or metadata change, when the backup records one. */
  updatedAt?: string;
  expiresAt: string | null;
  /** A text's name, as it was. */
  name?: string;
};

/**
 * Live connection settings for the page. Clients send `ping` every
 * `pingSeconds` and get `pong` back, which keeps proxies from closing an idle
 * connection; a tab hidden for `hiddenCloseSeconds` closes its connection and
 * reopens it when shown.
 */
export const LIVE = {
  ping: "ping",
  pong: "pong",
  pingSeconds: 60,
  hiddenCloseSeconds: 60,
} as const;

/** What a namespace needs from its platform. */
export interface NamespaceHost {
  /** Whether the namespace has any storage, checked without creating it. */
  hasStorage(): boolean;
  /** The namespace's own database, created on first use. */
  sql(): Sql;
  /** Deletes the database and any scheduled alarm. */
  deleteStorage(): Promise<void>;
  /** Schedules alarm() (replacing any earlier one), or cancels it with null. */
  setAlarm(time: number | null): Promise<void>;
  sockets(): LiveSocket[];
  blobs: BlobStore;
  hub(): HubApi;
}

/**
 * One namespace: its item queue, its access log and the live-update sockets
 * of everyone viewing it. It comes into being with its first item and
 * deletes all of its storage once it has been empty for a while.
 */
export class NamespaceCore {
  /** Whether the tables exist in this instance; a cleanup drops them. */
  private schemaReady = false;
  private readonly queue = new Queue(() => this.sql);
  private readonly log = new AccessLog(() => this.sql);

  /** A version newer than an item's, even when two changes share a millisecond. */
  private nextUpdate(item: StoredItem): string {
    const current = Date.parse(item.updatedAt ?? item.createdAt);
    return new Date(Math.max(Date.now(), current + 1)).toISOString();
  }

  constructor(
    private readonly config: AppConfig,
    private readonly host: NamespaceHost,
  ) {}

  private get sql(): Sql {
    const sql = this.host.sql();
    if (!this.schemaReady) {
      sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      sql.exec(QUEUE_SCHEMA);
      sql.exec(ACCESS_LOG_SCHEMA);
      this.schemaReady = true;
    }
    return sql;
  }

  // --- Identity ---------------------------------------------------------

  /**
   * Whether the namespace exists. Opening its page, listing it or watching
   * it live stores nothing; only sending does.
   */
  private exists(): boolean {
    return this.existing() !== null;
  }

  /** The namespace if it exists, checked without creating any storage. */
  private existing(): NamespaceRef | null {
    return this.schemaReady || this.host.hasStorage() ? this.ref() : null;
  }

  /** Which namespace this is; set by its first item. */
  private ref(): NamespaceRef | null {
    const rows = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM meta");
    const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return meta.space && meta.name
      ? { space: meta.space as NamespaceRef["space"], name: meta.name }
      : null;
  }

  private metaValue(key: string): string | null {
    return (
      this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value ??
      null
    );
  }

  private remember(ref: NamespaceRef): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('space', ?), ('name', ?)",
      ref.space,
      ref.name,
    );
  }

  // --- Write access -----------------------------------------------------

  /**
   * The SHA-256 (hex) of the key that writes here once locked; null while
   * anyone may. The key itself is never stored.
   */
  private writeVerifier(): string | null {
    return this.exists() ? this.metaValue("write") : null;
  }

  async isLocked(): Promise<boolean> {
    return this.writeVerifier() !== null;
  }

  /** Whether a write with the key whose SHA-256 is `verifier` may go. */
  async checkWrite(verifier: string | null): Promise<WriteCheck> {
    const expected = this.writeVerifier();
    if (expected === null) return "open";
    if (verifier === null) return "missing";
    return verifier === expected ? "ok" : "wrong";
  }

  /**
   * Locks the namespace: from now on only the key whose SHA-256 is
   * `verifier` writes here, while anyone may still read. A locked namespace
   * takes a new key only from its current one (`current`). With
   * `onlyEmpty`, an open namespace with items is refused: whoever knows a
   * plain name could otherwise take a namespace others use.
   */
  async lock(
    ref: NamespaceRef,
    verifier: string,
    current: string | null,
    onlyEmpty: boolean,
  ): Promise<LockResult> {
    const expected = this.writeVerifier();
    if (expected !== null && current !== expected) return "wrong";
    if (expected === null && onlyEmpty && this.exists() && this.queue.all().length) {
      return "not-empty";
    }
    // A namespace locked before its first item exists from now on (and is
    // cleaned up like any empty one if nothing comes).
    this.remember(ref);
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('write', ?)", verifier);
    await this.changed();
    return "locked";
  }

  /** Opens a locked namespace to every writer again, given its key. */
  async unlock(verifier: string | null): Promise<boolean> {
    const expected = this.writeVerifier();
    if (expected === null || verifier !== expected) return false;
    this.sql.exec("DELETE FROM meta WHERE key = 'write'");
    await this.changed();
    return true;
  }

  // --- Upkeep -----------------------------------------------------------

  private expiryFrom(now: number): string | null {
    return this.config.itemTtlMs ? new Date(now + this.config.itemTtlMs).toISOString() : null;
  }

  private async deleteFiles(items: StoredItem[]): Promise<void> {
    const keys = items.filter(hasObject).map((item) => item.object);
    if (keys.length) await this.host.blobs.delete(keys);
  }

  /** Removes expired items and their files; true when anything changed. */
  private async expire(): Promise<boolean> {
    const expired = this.queue.takeExpired(Date.now());
    await this.deleteFiles(expired);
    return expired.length > 0;
  }

  /**
   * The common start of every operation on an existing namespace. Each takes
   * the request's visit, so the access log is written in the same call.
   */
  private async enter(visit: AccessEvent | undefined): Promise<void> {
    this.recordVisit(visit);
    if (await this.expire()) await this.changed();
  }

  /** Visits are only logged once the namespace exists, so probes leave no trace. */
  private recordVisit(visit: AccessEvent | undefined): void {
    if (visit && this.exists()) this.log.record(visit);
  }

  /** After any change: push the queue to live viewers, reschedule expiry, update stats. */
  private async changed(): Promise<void> {
    const ref = this.ref();
    if (!ref) return;
    const items = this.queue.all();
    const message = this.snapshot(items);
    for (const socket of this.host.sockets()) {
      try {
        socket.send(message);
      } catch {
        // A socket closing right now gets the queue on its next connection.
      }
    }
    await this.scheduleAlarm(items);
    await this.report(items);
  }

  /**
   * One alarm per namespace: the next item expiry or, once the namespace is
   * empty, its cleanup after EMPTY_NAMESPACE_TTL_SECONDS.
   */
  private async scheduleAlarm(items: StoredItem[]): Promise<void> {
    if (!items.length) {
      await this.host.setAlarm(Date.now() + this.config.emptyNamespaceTtlMs);
      return;
    }
    await this.host.setAlarm(this.queue.nextExpiry());
  }

  /** Sizes for the hub. `closing` may still be listed among the sockets. */
  private async report(known?: StoredItem[], closing?: LiveSocket): Promise<void> {
    // Namespaces that do not exist are not listed (and must not get tables).
    const ref = this.existing();
    if (!ref) return;
    const items = known ?? this.queue.all();
    await this.host.hub().reportNamespace(ref, {
      items: items.length,
      bytes: items.reduce((total, item) => total + item.size, 0),
      connections: this.host.sockets().filter((socket) => socket !== closing).length,
    });
  }

  async alarm(): Promise<void> {
    // Expired items go now; if that empties the namespace, changed() plans
    // its cleanup for later.
    if (await this.expire()) {
      await this.changed();
      return;
    }
    const ref = this.existing();
    if (!ref || this.queue.all().length) {
      await this.changed();
      return;
    }
    // Empty for the whole wait. Someone looking at it keeps it alive.
    if (this.host.sockets().length) {
      await this.host.setAlarm(Date.now() + this.config.emptyNamespaceTtlMs);
      return;
    }
    await this.cleanUp(ref);
  }

  /** Brings timers and stats up to date, as after a restart. */
  async resume(): Promise<void> {
    if (!this.exists()) return;
    await this.expire();
    await this.changed();
  }

  /** Forgets the namespace everywhere and deletes all its storage. */
  private async cleanUp(ref: NamespaceRef): Promise<void> {
    await this.host.hub().forgetNamespace(ref);
    await this.host.deleteStorage();
    this.schemaReady = false;
  }

  /** Asked by the hub's sweep for a namespace it lists as empty for too long. */
  async cleanUpIfEmpty(ref: NamespaceRef): Promise<void> {
    const own = this.existing();
    if (!own) {
      await this.host.hub().forgetNamespace(ref);
      return;
    }
    if (this.host.sockets().length) return;
    await this.expire();
    if (this.queue.all().length) {
      await this.changed();
      return;
    }
    await this.cleanUp(own);
  }

  // --- Items ------------------------------------------------------------

  async list(visit?: AccessEvent): Promise<StoredItem[]> {
    if (!this.exists()) return [];
    await this.enter(visit);
    return this.queue.all();
  }

  /**
   * Adds an item under a new ID, unique in this namespace. Contents already
   * in the queue (same kind and SHA-256, neither burning after reading) are
   * not stored twice: that item moves to the top with a fresh expiry, and the
   * caller deletes the file it uploaded, if any.
   */
  async save(
    ref: NamespaceRef,
    input: SaveInput,
    burn: boolean,
    visit?: AccessEvent,
  ): Promise<Saved> {
    this.remember(ref);
    this.recordVisit(visit);
    await this.expire();

    // Never the same millisecond as the newest item: an item's time alone
    // then tells its place in the queue, as backups rely on.
    const now = Math.max(Date.now(), this.queue.newestTime() + 1);
    const same = !burn && input.sha256 ? this.queue.sameContents(input.kind, input.sha256) : null;
    if (same) {
      // Sent again: now the newest, expiring as if just sent, under the new
      // name if the send gave one.
      const rename = "named" in input && input.named && "filename" in same ? input.filename : null;
      const moved: StoredItem = {
        ...same,
        ...(rename ? { filename: rename } : {}),
        createdAt: new Date(now).toISOString(),
        expiresAt: this.expiryFrom(now),
      };
      this.queue.push(moved);
      // Its share link lives as long as the item.
      await this.host.hub().extendShare(ref, moved.id, moved.expiresAt);
      await this.changed();
      return { item: moved, existing: true };
    }

    const item = newItem(
      this.queue.freshId(),
      input,
      burn,
      new Date(now).toISOString(),
      this.expiryFrom(now),
    );
    this.queue.push(item);
    await this.deleteFiles(this.queue.trimTo(this.config.maxItems));
    await this.changed();
    return { item, existing: false };
  }

  /**
   * Puts back items from a backup, oldest first, with their IDs and dates.
   * An item whose contents are already here is left out. An existing ID takes
   * a newer name, or newer text contents from an incremental backup; files
   * remain immutable. Restoring the same backup twice therefore changes
   * nothing. An item already expired is left out too. Items expire by this
   * instance's rule at the latest. Returns uploaded file keys that were not
   * kept, for the caller to delete.
   */
  async restore(
    ref: NamespaceRef,
    items: Restored[],
  ): Promise<{ restored: number; skipped: string[] }> {
    this.remember(ref);
    await this.expire();
    const now = Date.now();
    const latest = this.expiryFrom(now);
    const skipped: string[] = [];
    const replacedFiles: StoredItem[] = [];
    let restored = 0;
    for (const { input, id, createdAt, updatedAt, expiresAt, name } of items) {
      const expiry =
        expiresAt && latest
          ? new Date(Math.min(Date.parse(expiresAt), Date.parse(latest))).toISOString()
          : (expiresAt ?? latest);
      const existing = this.queue.find(id);
      if (existing) {
        const currentChange = Date.parse(existing.updatedAt ?? existing.createdAt);
        const incomingChange = updatedAt ? Date.parse(updatedAt) : Number.NEGATIVE_INFINITY;
        // A sealed body's ciphertext has no stored digest. For a newer backup,
        // keep its body together with its metadata: changing only the latter
        // could pair a new revision with the old revision's ciphertext.
        const sameContents =
          existing.kind === input.kind &&
          existing.size === input.size &&
          existing.kind !== "sealed" &&
          Boolean(existing.sha256 && input.sha256 && existing.sha256 === input.sha256);
        if (sameContents && incomingChange > currentChange) {
          const change: Rename | null =
            input.kind === "text"
              ? { name: name ?? "" }
              : input.kind === "image" || input.kind === "file"
                ? { name: input.filename }
                : null;
          if (change) {
            const renamed = renamedItem(existing, change);
            if (!("error" in renamed)) {
              this.queue.update({ ...renamed, updatedAt });
              restored += 1;
            }
          }
        } else if (incomingChange > currentChange) {
          const editable =
            (existing.kind === "text" && input.kind === "text") ||
            (existing.kind === "sealed" && input.kind === "sealed");
          if (editable && updatedAt) {
            const replaced = replacedItem(existing, input, updatedAt);
            if (!("error" in replaced)) {
              const restoredItem =
                replaced.kind === "text" && name !== undefined ? { ...replaced, name } : replaced;
              this.queue.update(restoredItem);
              if (
                hasObject(existing) &&
                (!hasObject(restoredItem) || restoredItem.object !== existing.object)
              ) {
                replacedFiles.push(existing);
              }
              restored += 1;
              continue;
            }
          }
        }
        if ("object" in input) skipped.push(input.object);
        continue;
      }
      const known = input.sha256
        ? this.queue.sameContents(input.kind, input.sha256) !== null
        : false;
      if (known || (expiry !== null && Date.parse(expiry) <= now)) {
        if ("object" in input) skipped.push(input.object);
        continue;
      }
      const item = newItem(id, input, false, createdAt, expiry);
      const dated = updatedAt ? { ...item, updatedAt } : item;
      this.queue.push(dated.kind === "text" && name !== undefined ? { ...dated, name } : dated);
      restored += 1;
    }
    // Restored items keep their dates, so their place is by date too, in
    // whatever order the parts of a backup come back.
    if (restored) this.queue.sortByDate();
    await this.deleteFiles([...replacedFiles, ...this.queue.trimTo(this.config.maxItems)]);
    await this.changed();
    return { restored, skipped };
  }

  /**
   * A text item, or null for anything else. A burn-after-reading text is
   * deleted by this read.
   */
  async readText(ref: ItemRef, visit?: AccessEvent): Promise<InlineTextItem | null> {
    if (!this.exists()) return null;
    await this.enter(visit);
    const item = this.queue.find(ref);
    if (item?.kind !== "text" || hasObject(item)) return null;
    if (item.burn) {
      this.queue.remove(item.id);
      await this.changed();
    }
    return item;
  }

  /**
   * Hands out a file-backed item to be streamed from the blob store. A
   * burn-after-reading item is removed here, before any await, so no second
   * reader can claim it; deleting its file is then the caller's job.
   */
  async claimObject(ref: ItemRef, visit?: AccessEvent): Promise<ObjectItem | null> {
    if (!this.exists()) return null;
    await this.enter(visit);
    const item = this.queue.find(ref);
    if (!item || !hasObject(item)) return null;
    if (item.burn) {
      this.queue.remove(item.id);
      await this.changed();
    }
    return item;
  }

  /** One item as it is now, without consuming it. */
  async peek(ref: ItemRef, visit?: AccessEvent): Promise<StoredItem | null> {
    if (!this.exists()) return null;
    await this.enter(visit);
    return this.queue.find(ref);
  }

  /** One item and its position in the queue (1 is the newest), without consuming it. */
  async locate(
    ref: ItemRef,
    visit?: AccessEvent,
  ): Promise<{ item: StoredItem; position: number } | null> {
    if (!this.exists()) return null;
    await this.enter(visit);
    const item = this.queue.find(ref);
    return item ? { item, position: this.queue.position(item.id) } : null;
  }

  /** Renames an item; see renamedItem for what a name means for each kind. */
  async rename(
    ref: ItemRef,
    change: Rename,
    visit?: AccessEvent,
  ): Promise<{ item: StoredItem } | { error: string } | null> {
    if (!this.exists()) return null;
    await this.enter(visit);
    const item = this.queue.find(ref);
    if (!item) return null;
    const renamed = renamedItem(item, change);
    if ("error" in renamed) return renamed;
    const updated = { ...renamed, updatedAt: this.nextUpdate(item) };
    this.queue.update(updated);
    await this.changed();
    return { item: updated };
  }

  /**
   * Replaces a text's contents (see replacedItem). `expected` is the version
   * the client saw (its updatedAt, else createdAt): if the item changed
   * since, nothing happens and the answer says so. The old contents' file,
   * if any, is deleted; the new one's is the caller's until this succeeds.
   */
  async replace(
    ref: ItemRef,
    input: SaveInput,
    expected: string,
    visit?: AccessEvent,
  ): Promise<{ item: StoredItem } | { error: string; conflict?: true } | null> {
    if (!this.exists()) return null;
    await this.enter(visit);
    const item = this.queue.find(ref);
    if (!item) return null;
    if (expected !== (item.updatedAt ?? item.createdAt)) {
      return { error: "It changed since you opened it: open it again.", conflict: true };
    }
    const replaced = replacedItem(item, input, this.nextUpdate(item));
    if ("error" in replaced) return replaced;
    this.queue.update(replaced);
    if (hasObject(item) && (!hasObject(replaced) || replaced.object !== item.object)) {
      await this.deleteFiles([item]);
    }
    await this.changed();
    return { item: replaced };
  }

  async remove(ref: ItemRef, visit?: AccessEvent): Promise<boolean> {
    if (!this.exists()) return false;
    this.recordVisit(visit);
    const item = this.queue.find(ref);
    if (!item) return false;
    this.queue.remove(item.id);
    await this.deleteFiles([item]);
    await this.changed();
    return true;
  }

  async accessLog(visit?: AccessEvent): Promise<AccessLogEntry[]> {
    if (!this.exists()) return [];
    this.recordVisit(visit);
    return this.log.entries();
  }

  // --- Live updates -----------------------------------------------------

  /** The message every viewer gets: { type: "items", items, locked }. */
  private snapshot(items: StoredItem[]): string {
    return JSON.stringify({
      type: "items",
      items: items.map((item) => summaryItem(item)),
      locked: this.writeVerifier() !== null,
    });
  }

  canWatch(): boolean {
    return this.host.sockets().length < this.config.maxLiveConnections;
  }

  /**
   * A new viewer: the queue to send it first. Watching stores nothing, so a
   * device can wait on a namespace that does not exist yet and get its first
   * item the moment another device sends it.
   */
  async watch(visit?: AccessEvent): Promise<string> {
    return this.snapshot(await this.list(visit));
  }

  /**
   * Call after a socket was added or closed (pass it as `closing`). Every
   * viewer hears how many pages are open on the namespace now, its own
   * included: { type: "viewers", count }.
   */
  async watchersChanged(closing?: LiveSocket): Promise<void> {
    const sockets = this.host.sockets().filter((socket) => socket !== closing);
    const message = JSON.stringify({ type: "viewers", count: sockets.length });
    for (const socket of sockets) {
      try {
        socket.send(message);
      } catch {
        // Closing as well: it has nobody left to tell.
      }
    }
    await this.report(undefined, closing);
  }
}
