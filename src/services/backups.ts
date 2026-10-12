// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Backups as zip or tar, and back. Encrypted items stay encrypted, so a backup
// needs no secret; burn-after-reading items are left out, since reading them
// would consume them.
import {
  type ArchiveEntry,
  type ArchiveFormat,
  archiveSize,
  entrySize,
  type ReadEntry,
  readArchive,
  writeArchive,
} from "../core/archive";
import {
  describePlainFile,
  hashing,
  InvalidUtf8Error,
  objectKey,
  peek,
  sha256Of,
  strictUtf8,
  TEXT_MIME,
  validatedText,
} from "../core/contents";
import { SIGNATURE_BYTES, safeTextFileName } from "../core/media";
import {
  ITEM_ID_LENGTH,
  type NamespaceRef,
  objectName,
  plainName,
  readLimitedItem,
  SEALED_METADATA_PATTERN,
  type StoredItem,
  sealedName,
} from "../core/model";
import type { Restored, SaveInput } from "../core/namespace";
import type { Deps } from "./deps";
import { storageRefusal } from "./storage";

const MANIFEST = "manifest.json";
export const BACKUP_FORMATS: ArchiveFormat[] = ["zip", "tar"];
const ITEM_ID = new RegExp(`^[a-z]{${ITEM_ID_LENGTH}}$`);
/** A namespace's manifest is read whole, so it is held to what its items can need. */
const MANIFEST_BYTES_PER_ITEM = 4_096;

type ManifestItem = {
  id: string;
  kind: "text" | "image" | "file" | "sealed";
  createdAt: string;
  updatedAt?: string;
  expiresAt: string | null;
  size: number;
  path: string;
  name?: string;
  filename?: string;
  mime?: string;
  /** X-Sealed-Metadata, so restoring needs no key. */
  metadata?: string;
};
type ManifestNamespace = NamespaceRef & { items: ManifestItem[] };
export type Manifest = {
  kurobako: "backup";
  version: 1;
  exportedAt: string;
  namespaces: ManifestNamespace[];
  next?: string;
};

const encoder = new TextEncoder();

/** Where a part ended, so the next one starts there even if that item is gone. */
export type Cursor = NamespaceRef & { createdAt: string; id: string; part: number };

const encodeCursor = (cursor: Cursor) =>
  Buffer.from(
    JSON.stringify([cursor.space, cursor.name, cursor.createdAt, cursor.id, cursor.part]),
  ).toString("base64url");

export const decodeCursor = (text: string): Cursor | null => {
  try {
    const [space, name, createdAt, id, part] = JSON.parse(
      Buffer.from(text, "base64url").toString("utf8"),
    ) as unknown[];
    const valid =
      (space === "plain" || space === "sealed") &&
      typeof name === "string" &&
      typeof createdAt === "string" &&
      typeof id === "string" &&
      Number.isSafeInteger(part);
    return valid ? { space, name, createdAt, id, part: part as number } : null;
  } catch {
    return null;
  }
};

/**
 * `max` bounds the whole archive, headers and manifest included: a part must
 * fit in one request to be restored (Workers take 100 MB on Free and Pro).
 */
export type BackupPart = { since: number | null; max: number | null; after: Cursor | null };

type Candidate = { ref: NamespaceRef; item: StoredItem; path: string };

/** Code-unit order, the same on every server, so cursors stay valid between them. */
const compare = (a: string[], b: string[]) => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const [x = "", y = ""] = [a[index], b[index]];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};
const compareRefs = (a: NamespaceRef, b: NamespaceRef) =>
  compare([a.space, a.name], [b.space, b.name]);

/** Old items have no updatedAt. */
const changedAt = (item: StoredItem) =>
  Math.max(Date.parse(item.createdAt), Date.parse(item.updatedAt ?? item.createdAt));

/** Oldest first; the stable sort keeps same-millisecond items in queue order. */
const exportable = (stored: StoredItem[], since: number | null) =>
  [...stored]
    .reverse()
    .filter((item) => !readLimitedItem(item) && (since === null || changedAt(item) >= since))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

const fileNameOf = (item: StoredItem) => {
  if (item.kind === "sealed") return `${item.id}.sealed`;
  if (item.kind === "text") return item.name ? safeTextFileName(item.name) : `text-${item.id}.txt`;
  return item.filename;
};

/** Unique across the whole namespace, so files from different parts never clash. */
const archivePaths = (ref: NamespaceRef, items: StoredItem[]) => {
  const taken = new Set<string>();
  const uniqueName = (item: StoredItem) => {
    const name = fileNameOf(item);
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0
      ? `${name.slice(0, dot)} (${item.id})${name.slice(dot)}`
      : `${name} (${item.id})`;
  };
  return new Map(
    items.map((item) => {
      const name = uniqueName(item);
      taken.add(name);
      return [item.id, `${ref.space}/${ref.name}/${name}`];
    }),
  );
};

/** If the cursor's item is gone, resume at its time: a restore skips repeats, nothing is missed. */
const resumeIndex = (items: StoredItem[], ref: NamespaceRef, after: Cursor | null) => {
  if (!after || compareRefs(ref, after) !== 0) return 0;
  const at = items.findIndex((item) => item.id === after.id);
  if (at >= 0) return at + 1;
  const later = items.findIndex((item) => item.createdAt >= after.createdAt);
  return later < 0 ? items.length : later;
};

const cursorOf = ({ ref, item }: Candidate, part: number): Cursor => ({
  space: ref.space,
  name: ref.name,
  createdAt: item.createdAt,
  id: item.id,
  part,
});

const manifestItem = ({ item, path }: Candidate): ManifestItem => ({
  id: item.id,
  kind: item.kind,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt || undefined,
  expiresAt: item.expiresAt,
  size: item.size,
  path,
  name: (item.kind === "text" && item.name) || undefined,
  filename: "filename" in item ? item.filename : undefined,
  mime: "filename" in item ? item.mime : undefined,
  metadata: item.kind === "sealed" ? item.metadata : undefined,
});

/** A namespace backed up alone is listed even when empty, so its restore says so. */
const manifestOf = (
  alone: NamespaceRef | null,
  chosen: Candidate[],
  next: string | null,
): Manifest => {
  const namespaces = new Map<string, ManifestNamespace>();
  if (alone) namespaces.set(objectName(alone), { space: alone.space, name: alone.name, items: [] });
  for (const candidate of chosen) {
    const { ref } = candidate;
    const key = objectName(ref);
    const ns = namespaces.get(key) ?? { space: ref.space, name: ref.name, items: [] };
    ns.items.push(manifestItem(candidate));
    namespaces.set(key, ns);
  }
  return {
    kurobako: "backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    namespaces: [...namespaces.values()],
    next: next ?? undefined,
  };
};

const manifestBytes = (manifest: Manifest) =>
  encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);

/** Room for an empty array opening up once it holds something. */
const SLACK = 16;

/** An upper bound, so the estimate errs high. */
const jsonBound = (value: unknown, depth: number) => {
  const json = JSON.stringify(value, null, 2);
  const lines = json.split("\n").length;
  return encoder.encode(json).byteLength + lines * depth * 2 + 2;
};

export const createBackups = ({
  namespace,
  hub,
  platform,
  config,
}: Pick<Deps, "namespace" | "hub" | "platform" | "config">) => {
  const { blobs } = platform;

  /** Lazy, so a full part stops listing namespaces. */
  async function* candidates(refs: NamespaceRef[], { since, after }: BackupPart) {
    for (const ref of [...refs].sort(compareRefs)) {
      if (after && compareRefs(ref, after) < 0) continue;
      const items = exportable((await namespace(ref).list()) as StoredItem[], since);
      const paths = archivePaths(ref, items);
      for (const item of items.slice(resumeIndex(items, ref, after))) {
        yield { ref, item, path: paths.get(item.id) as string };
      }
    }
  }

  /**
   * At least one item, however large, or a backup would never end. The manifest's share is
   * estimated high; backup() checks the real size.
   */
  const choose = async (
    refs: NamespaceRef[],
    format: ArchiveFormat,
    part: BackupPart,
    partNumber: number,
  ) => {
    const chosen: Candidate[] = [];
    const listed = new Set<string>();
    let contents = 0;
    let manifest = jsonBound(manifestOf(null, [], null), 0) + SLACK;
    for await (const candidate of candidates(refs, part)) {
      const key = objectName(candidate.ref);
      const { space, name } = candidate.ref;
      const namespaceCost = listed.has(key) ? 0 : jsonBound({ space, name, items: [] }, 2) + SLACK;
      const itemCost = jsonBound(manifestItem(candidate), 4);
      const cursor = encodeCursor(cursorOf(candidate, partNumber));
      const manifestSize = manifest + namespaceCost + itemCost + jsonBound({ next: cursor }, 1);
      const entry = entrySize(format, { path: candidate.path, size: candidate.item.size });
      const size = archiveSize(format, [{ path: MANIFEST, size: manifestSize }]) + contents + entry;
      if (part.max !== null && chosen.length > 0 && size > part.max) {
        return { chosen, more: true };
      }
      chosen.push(candidate);
      listed.add(key);
      contents += entry;
      manifest += namespaceCost + itemCost;
    }
    return { chosen, more: false };
  };

  const archiveEntry = ({ item, path }: Candidate): ArchiveEntry => ({
    path,
    size: item.size,
    modified: new Date(item.updatedAt ?? item.createdAt),
    open: async () => {
      if (!("object" in item)) {
        return new Blob([encoder.encode("text" in item ? item.text : "")]).stream();
      }
      const object = await blobs.get(item.object);
      if (!object) throw new Error(`The contents of ${path} are missing.`);
      return object.body;
    },
  });

  /** Parts are each a whole backup of their own items, restorable in any order. */
  const backup = async (refs: NamespaceRef[], format: ArchiveFormat, part: BackupPart) => {
    const partNumber = (part.after?.part ?? 0) + 1;
    const alone = refs.length === 1 ? (refs[0] as NamespaceRef) : null;
    const planned = await choose(refs, format, part, partNumber);
    const chosen = [...planned.chosen];
    let more = planned.more;

    const build = () => {
      const last = chosen.at(-1);
      const next = more && last ? encodeCursor(cursorOf(last, partNumber)) : null;
      const manifest = manifestBytes(manifestOf(alone, chosen, next));
      const sized = [{ path: MANIFEST, size: manifest.byteLength }, ...chosen.map(archiveEntry)];
      return { next, manifest, size: archiveSize(format, sized) };
    };
    // The estimate is meant to be high; this keeps `max` a promise even when it is not.
    let built = build();
    while (part.max !== null && built.size > part.max && chosen.length > 1) {
      chosen.pop();
      more = true;
      built = build();
    }

    const { manifest, next } = built;
    const archive = writeArchive(format, [
      {
        path: MANIFEST,
        size: manifest.byteLength,
        modified: new Date(),
        open: async () => new Blob([manifest]).stream(),
      },
      ...chosen.map(archiveEntry),
    ]);
    // An empty namespace answers as one that does not exist does (see misses.ts).
    const empty = alone !== null && chosen.length === 0 && !part.after;
    return { archive, part: partNumber, next, empty };
  };

  type Owner = { ref: NamespaceRef; item: ManifestItem };
  type Stored = { object: string; sha256?: string };
  type Put = (stream: ReadableStream<Uint8Array>, contentType: string) => Promise<Stored>;

  /** Every blob stored is remembered, so a failed restore leaves none behind. */
  const putter =
    (uploaded: string[], ref: NamespaceRef, size: number, hashed: boolean): Put =>
    async (stream, contentType) => {
      const object = objectKey(ref);
      const hash = hashed ? hashing(stream) : null;
      await blobs.put(object, hash?.stream ?? stream, size, contentType);
      uploaded.push(object);
      return { object, sha256: hash?.digest() };
    };

  /** Restored items follow a send's rules: UTF-8 texts, file types from their bytes. */
  const sealedInput = async (
    item: ManifestItem,
    size: number,
    body: ReadEntry["body"],
    put: Put,
  ): Promise<SaveInput | null> => {
    if (item.kind !== "sealed" || !SEALED_METADATA_PATTERN.test(item.metadata ?? "")) return null;
    if (size > config.maxFileBytes) return null;
    const { object } = await put(body, "application/octet-stream");
    return { kind: "sealed", metadata: item.metadata as string, object, size };
  };

  const inlineTextInput = async (
    size: number,
    body: ReadEntry["body"],
  ): Promise<SaveInput | null> => {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    try {
      return { kind: "text", text: strictUtf8().decode(bytes), size, sha256: sha256Of(bytes) };
    } catch {
      return null;
    }
  };

  const textInput = async (
    size: number,
    body: ReadEntry["body"],
    put: Put,
  ): Promise<SaveInput | null> => {
    if (size > config.maxTextBytes || size === 0) return null;
    if (size <= config.inlineTextBytes) return inlineTextInput(size, body);
    const external = validatedText({ body, size, head: new Uint8Array() });
    const { object, sha256 } = await put(external.upload.body, TEXT_MIME);
    try {
      external.validate();
    } catch (error) {
      if (error instanceof InvalidUtf8Error) return null;
      throw error;
    }
    const { input } = external;
    return input.kind === "text" && "preview" in input
      ? { kind: "text", preview: input.preview, object, size, sha256 }
      : null;
  };

  const fileInput = async (
    item: ManifestItem,
    size: number,
    body: ReadEntry["body"],
    put: Put,
  ): Promise<SaveInput | null> => {
    if (size > config.maxFileBytes || size === 0) return null;
    const { head, body: rest } = await peek(body, SIGNATURE_BYTES);
    const described = describePlainFile({ body: rest, size, head }, item.filename ?? null);
    if (described.kind !== "image" && described.kind !== "file") return null;
    const { object, sha256 } = await put(rest, described.mime);
    const { kind, mime, filename } = described;
    return { kind, mime, filename, object, size, sha256 };
  };

  const inputOf = (owner: Owner, entry: ReadEntry, uploaded: string[]) => {
    const { ref, item } = owner;
    const put = putter(uploaded, ref, entry.size, ref.space !== "sealed");
    if (!ITEM_ID.test(item.id)) return null;
    if (ref.space === "sealed") return sealedInput(item, entry.size, entry.body, put);
    if (item.kind === "text") return textInput(entry.size, entry.body, put);
    if (item.kind === "image" || item.kind === "file")
      return fileInput(item, entry.size, entry.body, put);
    return null;
  };

  /** Each part of a backup restores on its own, so the manifest is checked before any item. */
  const plan = async (entry: ReadEntry, into: NamespaceRef | null, maxItems: number | null) => {
    if (entry.path !== MANIFEST) refuse(400, "This archive has no Kurobako manifest first.");
    // The admin's manifest, for the whole instance, is trusted with any size.
    if (maxItems !== null && entry.size > MANIFEST_BYTES_PER_ITEM * (maxItems + 1)) {
      refuse(413, "This manifest is larger than a namespace's can be.");
    }
    const manifest: unknown = JSON.parse(
      new TextDecoder().decode(await new Response(entry.body).arrayBuffer()),
    );
    if (!isManifest(manifest)) refuse(400, "Not a Kurobako backup manifest.");
    if (into && manifest.namespaces.length !== 1) {
      refuse(400, "A namespace takes a backup of one namespace.");
    }
    const owners = new Map<string, Owner>(
      manifest.namespaces.flatMap((ns) => {
        const ref = targetOf(ns, into, maxItems);
        return ns.items.map((item) => [item.path, { ref, item }] as const);
      }),
    );
    // Room for the whole backup, as if nothing in it were here yet.
    const total = [...owners.values()].reduce((sum, { item }) => sum + item.size, 0);
    const full = await storageRefusal(config, hub, total);
    if (full) refuse(507, full);
    return owners;
  };

  const readBackup = async (
    body: ReadableStream<Uint8Array>,
    into: NamespaceRef | null,
    maxItems: number | null,
    uploaded: string[],
  ) => {
    const owners = new Map<string, Owner>();
    // Zip entries written as streams only say their size in the manifest.
    const entries = readArchive(body, (path) => owners.get(path)?.item.size);
    const first = await entries.next();
    if (first.done) refuse(400, "This archive is empty.");
    for (const [path, owner] of await plan(first.value, into, maxItems)) owners.set(path, owner);

    const batches = new Map<string, { ref: NamespaceRef; items: Restored[] }>();
    let rejected = 0;
    for await (const entry of entries) {
      const owner = owners.get(entry.path);
      // Not in the manifest: the reader skips its bytes.
      if (!owner) continue;
      const input = await inputOf(owner, entry, uploaded);
      if (!input) {
        rejected += 1;
        continue;
      }
      const key = objectName(owner.ref);
      const batch = batches.get(key) ?? { ref: owner.ref, items: [] };
      batch.items.push(restoredItem(owner.item, input));
      batches.set(key, batch);
    }
    return { batches: [...batches.values()], rejected };
  };

  const restore = async (
    body: ReadableStream<Uint8Array>,
    into: NamespaceRef | null,
    { maxItems, verifier }: { maxItems: number | null; verifier: string | null },
  ): Promise<RestoreResult> => {
    const uploaded: string[] = [];
    let read: Awaited<ReturnType<typeof readBackup>>;
    try {
      read = await readBackup(body, into, maxItems, uploaded);
    } catch (error) {
      if (uploaded.length) await blobs.delete(uploaded);
      if (error instanceof RestoreError) return { error: error.message, status: error.status };
      return { error: `Could not read the archive: ${(error as Error).message}`, status: 400 };
    }

    let restored = 0;
    let skipped = 0;
    for (const { ref, items } of read.batches) {
      const result = await namespace(ref).restore(ref, items, into ? verifier : undefined);
      restored += result.restored;
      skipped += items.length - result.restored;
      if (result.skipped.length) await blobs.delete(result.skipped);
    }
    return { restored, skipped, rejected: read.rejected, namespaces: read.batches.length };
  };

  return { backup, restore };
};

export type RestoreResult =
  | { restored: number; skipped: number; rejected: number; namespaces: number }
  | { error: string; status: 400 | 413 | 507 };

/** Thrown to stop a restore with an answer for the client, not a failure of the server. */
class RestoreError extends Error {
  constructor(
    readonly status: 400 | 413 | 507,
    message: string,
  ) {
    super(message);
  }
}
function refuse(status: 400 | 413 | 507, message: string): never {
  throw new RestoreError(status, message);
}

const isManifest = (value: unknown): value is Manifest => {
  const manifest = value as Manifest;
  return (
    manifest?.kurobako === "backup" &&
    manifest.version === 1 &&
    Array.isArray(manifest.namespaces) &&
    manifest.namespaces.every((ns) => Array.isArray(ns?.items))
  );
};

/** Encrypted items only open with their own namespace's key, so they never move. */
const targetOf = (
  ns: ManifestNamespace,
  into: NamespaceRef | null,
  maxItems: number | null,
): NamespaceRef => {
  const ref = into ?? { space: ns.space, name: ns.name };
  const valid = ref.space === "sealed" ? sealedName(ref.name) : plainName(ref.name);
  if (!valid || (ref.space === "sealed") !== (ns.space === "sealed")) {
    refuse(400, `${ns.space}/${ns.name} cannot be restored here.`);
  }
  if (ref.space === "sealed" && ref.name !== ns.name) {
    refuse(400, "Encrypted items only open in their own namespace.");
  }
  if (maxItems !== null && ns.items.length > maxItems) {
    refuse(413, `A namespace holds at most ${maxItems} items.`);
  }
  return ref;
};

/** Hand-edited manifests may carry dates that do not parse. */
const isoOr = <T>(value: string | null | undefined, fallback: T) =>
  value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback;

const restoredItem = (item: ManifestItem, input: SaveInput): Restored => ({
  input,
  id: item.id,
  createdAt: isoOr(item.createdAt, new Date().toISOString()),
  updatedAt: isoOr(item.updatedAt, undefined),
  expiresAt: isoOr(item.expiresAt, null),
  name: item.kind === "text" && typeof item.name === "string" ? item.name : undefined,
});
