// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// One namespace: what it does with its queue (queue.ts) and access log
// (access-log.ts), its expiry and cleanup timers, its live viewers and what it
// tells the hub.
import type { AppConfig } from "../config";
import {
  hasObject,
  type InlineTextItem,
  lastRead,
  type NamespaceRef,
  type ObjectItem,
  readLimitedItem,
  type StoredItem,
  summaryItem,
} from "../model";
import type { BlobStore, HubApi, LiveSocket, Sql } from "../platform";
import type { AccessEvent, AccessLogEntry } from "../request-info";
import { slotOf, slotPrefix } from "../routing";
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
import { VIEW_SCHEMA, type ViewEntry, Views } from "./views";

export type { ItemRef, Rename, SaveInput };

/** Whether a write has the namespace's capability. */
export type WriteCheck = "open" | "ok" | "missing" | "wrong";

/** The first 128 bits of SHA-256(base64url(write key)), encoded as a namespace ID. */
const sealedIdOfVerifier = (verifier: string): string | null => {
  if (!/^[a-f0-9]{64}$/.test(verifier)) return null;
  const first = verifier.slice(0, 32).match(/../g) ?? [];
  return btoa(String.fromCharCode(...first.map((part) => Number.parseInt(part, 16))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

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
  private readonly views = new Views(() => this.sql);

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
      for (const statement of VIEW_SCHEMA) sql.exec(statement);
      this.schemaReady = true;
      if (!sql.exec("SELECT value FROM meta WHERE key = 'live_revision'").length) {
        const baseline = JSON.stringify(this.queue.all().map(summaryItem));
        sql.exec(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('live_revision', '0'), ('live_snapshot', ?)",
          baseline,
        );
      }
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

  private remember(ref: NamespaceRef): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('space', ?), ('name', ?)",
      ref.space,
      ref.name,
    );
  }

  // --- Write access -----------------------------------------------------

  /** An encrypted write key must match the public namespace ID even before first send. */
  async checkWrite(ref: NamespaceRef, verifier: string | null): Promise<WriteCheck> {
    if (ref.space === "plain") return "open";
    if (verifier === null) return "missing";
    return sealedIdOfVerifier(verifier) === ref.name ? "ok" : "wrong";
  }

  private async assertWrite(ref: NamespaceRef, verifier: string | null): Promise<void> {
    if ((await this.checkWrite(ref, verifier)) === "ok" || ref.space === "plain") return;
    throw new Error("Write access denied.");
  }

  // --- Upkeep -----------------------------------------------------------

  private expiryFrom(now: number, expiresInSeconds: number | null = null): string | null {
    const duration = expiresInSeconds === null ? this.config.itemTtlMs : expiresInSeconds * 1000;
    return duration ? new Date(now + duration).toISOString() : null;
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

  private revision(): number {
    return Number(
      this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'live_revision'")[0]
        ?.value ?? 0,
    );
  }

  /** After any change: publish only the queue delta, then reschedule expiry and stats. */
  private async changed(): Promise<void> {
    const ref = this.ref();
    if (!ref) return;
    const items = this.queue.all();
    const current = items.map(summaryItem);
    const encoded = JSON.stringify(current);
    const previous = this.sql.exec<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'live_snapshot'",
    )[0]?.value;
    if (previous !== encoded) {
      const before = (previous ? JSON.parse(previous) : []) as ReturnType<typeof summaryItem>[];
      const old = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
      const next = new Set(current.map((item) => item.id));
      const revision = this.revision() + 1;
      this.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('live_revision', ?), ('live_snapshot', ?)",
        String(revision),
        encoded,
      );
      const message = JSON.stringify({
        type: "change",
        revision,
        upserts: current.filter((item) => old.get(item.id) !== JSON.stringify(item)),
        removed: before.filter((item) => !next.has(item.id)).map((item) => item.id),
        order: current.map((item) => item.id),
      });
      for (const socket of this.host.sockets()) {
        try {
          socket.send(message);
        } catch {
          // A dropped viewer reconciles against /ls on its next connection.
        }
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
    return (await this.listState(visit)).items;
  }

  /** Queue and revision are read together for race-free WebSocket bootstrap. */
  async listState(visit?: AccessEvent): Promise<{ items: StoredItem[]; revision: number }> {
    if (!this.exists()) return { items: [], revision: 0 };
    await this.enter(visit);
    return { items: this.queue.all(), revision: this.revision() };
  }

  /** A writer's consistent item list, active view and historical view IDs. */
  async viewsStatus(ref: NamespaceRef, verifier: string | null) {
    await this.assertWrite(ref, verifier);
    if (!this.exists()) return { items: [] as StoredItem[], views: [] as ReturnType<Views["all"]> };
    await this.enter(undefined);
    return { items: this.queue.all(), views: this.views.all() };
  }

  /** A new view freezes the old membership. A stale item list never rotates. */
  async createView(
    ref: NamespaceRef,
    viewId: string,
    entries: ViewEntry[],
    previousToken: string | null,
    verifier: string | null,
  ): Promise<ReturnType<Views["rotate"]>> {
    await this.assertWrite(ref, verifier);
    // A canonical unpadded base64url encoding of exactly 16 bytes ends in
    // A, Q, g or w; accepting another spelling would derive a different key.
    if (!/^[A-Za-z0-9_-]{21}[AQgw]$/.test(viewId)) throw new Error("Invalid view ID.");
    if (this.exists()) await this.enter(undefined);
    const current = this.exists() ? this.queue.all() : [];
    if ((this.exists() ? (this.views.active()?.token ?? null) : null) !== previousToken) {
      throw new Error("View changed.");
    }
    if (
      entries.length !== current.length ||
      entries.some((entry, i) => entry.id !== current[i]?.id)
    ) {
      throw new Error("View changed.");
    }
    if (
      ref.space === "sealed" &&
      entries.some((entry) => !/^[A-Za-z0-9_-]{59}$/.test(entry.envelope ?? ""))
    ) {
      throw new Error("Missing or invalid view envelope.");
    }
    if (this.exists() && this.views.all().some((view) => view.viewId === viewId)) {
      throw new Error("View changed.");
    }
    if (this.exists() && this.views.all().length >= 100) throw new Error("Too many views.");
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    const token = `${slotPrefix(slotOf(ref))}${btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")}`;
    // Route registration precedes publication. A losing rotation removes it.
    await this.host.hub().registerView(ref, token);
    let published = false;
    try {
      await this.assertWrite(ref, verifier);
      const latest = this.exists() ? this.queue.all() : [];
      if ((this.exists() ? (this.views.active()?.token ?? null) : null) !== previousToken) {
        throw new Error("View changed.");
      }
      if (this.views.all().some((view) => view.viewId === viewId)) throw new Error("View changed.");
      if (
        entries.length !== latest.length ||
        entries.some((entry, i) => entry.id !== latest[i]?.id)
      ) {
        throw new Error("View changed.");
      }
      this.remember(ref);
      const created = this.views.rotate(token, viewId, entries);
      published = true;
      await this.changed();
      return created;
    } finally {
      if (!published) await this.host.hub().forgetView(token);
    }
  }

  /** Only live members are returned; their names and bytes stay at item shares. */
  async viewContents(token: string, visit?: AccessEvent) {
    if (!this.exists()) return null;
    await this.enter(visit);
    const view = this.views.get(token);
    if (!view) return null;
    const items = new Map(this.queue.all().map((item) => [item.id, item]));
    return {
      ...view,
      entries: this.views.entries(token).flatMap(({ id, envelope }) => {
        const item = items.get(id);
        return item ? [{ item, ...(envelope ? { envelope } : {}) }] : [];
      }),
    };
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
    expiresInSeconds: number | null = null,
    reads: number | null = null,
    verifier: string | null = null,
    view?: { token: string; envelope?: string },
    deduplicate = true,
  ): Promise<Saved> {
    await this.assertWrite(ref, verifier);
    this.remember(ref);
    this.recordVisit(visit);
    await this.expire();
    const active = this.views.active();
    if (ref.space === "sealed") {
      if (
        active?.token !== view?.token ||
        (active && !/^[A-Za-z0-9_-]{59}$/.test(view?.envelope ?? ""))
      ) {
        throw new Error("View changed.");
      }
    }

    // Never the same millisecond as the newest item: an item's time alone
    // then tells its place in the queue, as backups rely on.
    const now = Math.max(Date.now(), this.queue.newestTime() + 1);
    const same =
      deduplicate && !burn && reads === null && input.sha256
        ? this.queue.sameContents(input.kind, input.sha256)
        : null;
    if (same) {
      // Sent again: now the newest, expiring as if just sent, under the new
      // name if the send gave one.
      const rename =
        input.kind === "text" && same.kind === "text"
          ? input.name
          : "named" in input && input.named && "filename" in same
            ? input.filename
            : null;
      const moved: StoredItem = {
        ...same,
        ...(rename ? (same.kind === "text" ? { name: rename } : { filename: rename }) : {}),
        createdAt: new Date(now).toISOString(),
        expiresAt: this.expiryFrom(now, expiresInSeconds),
      };
      this.queue.push(moved);
      if (active) this.views.moveToFront(active.token, moved.id);
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
      this.expiryFrom(now, expiresInSeconds),
      reads,
    );
    this.queue.push(item);
    if (active) this.views.append(active.token, item.id, view?.envelope);
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
    verifier?: string | null,
  ): Promise<{ restored: number; skipped: string[] }> {
    if (verifier !== undefined) await this.assertWrite(ref, verifier);
    this.remember(ref);
    await this.expire();
    const active = this.views.active();
    if (ref.space === "sealed" && active && items.length) {
      throw new Error(
        "Import into an encrypted namespace with an active view needs view envelopes.",
      );
    }
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
    if (ref.space === "plain" && active) {
      this.views.syncPlain(
        active.token,
        this.queue.all().map((item) => item.id),
      );
    }
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
    if (readLimitedItem(item)) {
      if (!lastRead(item)) this.queue.update({ ...item, readsLeft: (item.readsLeft ?? 1) - 1 });
      else this.queue.remove(item.id);
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
    if (readLimitedItem(item)) {
      if (!lastRead(item)) this.queue.update({ ...item, readsLeft: (item.readsLeft ?? 1) - 1 });
      else this.queue.remove(item.id);
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
    expected: string | null,
    visit?: AccessEvent,
    verifier: string | null = null,
  ): Promise<{ item: StoredItem } | { error: string; conflict?: true } | null> {
    if (!this.exists()) return null;
    await this.enter(visit);
    const own = this.ref();
    if (own) await this.assertWrite(own, verifier);
    const item = this.queue.find(ref);
    if (!item) return null;
    if (expected !== null && expected !== (item.updatedAt ?? item.createdAt)) {
      return { error: "It changed since you opened it: open it again.", conflict: true };
    }
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
    verifier: string | null = null,
  ): Promise<{ item: StoredItem } | { error: string; conflict?: true } | null> {
    if (!this.exists()) return null;
    await this.enter(visit);
    const own = this.ref();
    if (own) await this.assertWrite(own, verifier);
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

  async remove(
    ref: ItemRef,
    visit?: AccessEvent,
    write?: { ref: NamespaceRef; verifier: string | null },
  ): Promise<boolean> {
    if (!this.exists()) return false;
    if (write) await this.assertWrite(write.ref, write.verifier);
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

  canWatch(): boolean {
    return this.host.sockets().length < this.config.maxLiveConnections;
  }

  /**
   * A new viewer: a readiness marker, without the queue. Watching stores nothing, so a
   * device can wait on a namespace that does not exist yet and get its first
   * item the moment another device sends it.
   */
  async watch(visit?: AccessEvent): Promise<string> {
    const { revision } = await this.listState(visit);
    return JSON.stringify({ type: "ready", revision });
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
