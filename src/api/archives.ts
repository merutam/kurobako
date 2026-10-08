// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Backups: a namespace, or with the admin key the whole instance, as a zip or
// a tar, and back.
//
//   GET  <ns>/zip, <ns>/tar      the namespace (?since=<date>: items sent or changed since;
//                                ?max=<bytes>: in parts, see archiveOf)
//   POST <ns>/import             puts a backup of one namespace back into this one (PUT too)
//   GET  /a/zip, /a/tar          every namespace (admin)
//   POST /a/import               puts back every namespace in a backup (admin)
//
// An archive starts with manifest.json, which lists each namespace and item
// with its details and the path of its contents. Texts and files are as they
// were sent; encrypted items stay encrypted (<id>.sealed, with their header
// in the manifest), so a backup needs no secret and reveals none. Items that
// burn after reading are left out: reading them would consume them.
import { type ArchiveEntry, type ArchiveFormat, readArchive, writeArchive } from "../archive";
import { SIGNATURE_BYTES, safeTextFileName } from "../image";
import {
  ITEM_ID_LENGTH,
  type NamespaceRef,
  objectName,
  plainName,
  readLimitedItem,
  SEALED_METADATA_PATTERN,
  type StoredItem,
  sealedName,
} from "../model";
import type { Restored, SaveInput } from "../namespace";
import { ADMIN_PATH } from "../routing";
import { type Api, type App, type AppContext, jsonError, writeVerifier } from "./context";
import { namespaceOf, SPACES } from "./namespaces";
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
} from "./uploads";

const MANIFEST = "manifest.json";
const FORMATS: ArchiveFormat[] = ["zip", "tar"];
const CONTENT_TYPES: Record<ArchiveFormat, string> = {
  zip: "application/zip",
  tar: "application/x-tar",
};
const ITEM_ID = new RegExp(`^[a-z]{${ITEM_ID_LENGTH}}$`);
/** Room for one item in a manifest: its details, a name, a path and a sealed header. */
const MANIFEST_BYTES_PER_ITEM = 4_096;

type ManifestItem = {
  id: string;
  kind: "text" | "image" | "file" | "sealed";
  createdAt: string;
  updatedAt?: string;
  expiresAt: string | null;
  size: number;
  /** Where its contents are in the archive. */
  path: string;
  name?: string;
  filename?: string;
  mime?: string;
  /** An encrypted item's X-Sealed-Metadata. */
  metadata?: string;
};
type ManifestNamespace = NamespaceRef & { items: ManifestItem[] };
export type Manifest = {
  kurobako: "backup";
  version: 1;
  exportedAt: string;
  namespaces: ManifestNamespace[];
  /** In one part of a backup, the cursor for the next part; absent in the last. */
  next?: string;
};

const encoder = new TextEncoder();
const day = (date: Date) => date.toISOString().slice(0, 10);

/** Where a part of a backup ended: its last item, and which part it was. */
type Cursor = NamespaceRef & { createdAt: string; id: string; part: number };
const encodeCursor = (cursor: Cursor) =>
  Buffer.from(
    JSON.stringify([cursor.space, cursor.name, cursor.createdAt, cursor.id, cursor.part]),
  ).toString("base64url");
const decodeCursor = (text: string): Cursor | null => {
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

/** Orders tuples of strings, field by field. */
const compare = (a: string[], b: string[]) => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const [x = "", y = ""] = [a[index], b[index]];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/** An item's file in the archive: its own name, or one made from its ID. */
const fileNameOf = (item: StoredItem) => {
  if (item.kind === "sealed") return `${item.id}.sealed`;
  if (item.kind === "text") return item.name ? safeTextFileName(item.name) : `text-${item.id}.txt`;
  return item.filename;
};

/** Makes `name` unique among `taken` by adding the item's ID before its extension. */
const unique = (name: string, id: string, taken: Set<string>) => {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${id})${name.slice(dot)}` : `${name} (${id})`;
};

const readAll = async (body: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(body).arrayBuffer());

/** The last change a backup needs to capture; old items have only createdAt. */
const changedAt = (item: Pick<StoredItem, "createdAt" | "updatedAt">) =>
  Math.max(Date.parse(item.createdAt), Date.parse(item.updatedAt ?? item.createdAt));

export const mountArchives = (app: App, api: Api) => {
  const { namespace, hub, platformOf, config, refuseSend, refuseWrite, storageFull } = api;

  // --- Export -------------------------------------------------------------

  /**
   * A backup of `refs`, or one part of it. Items go out by when they were
   * sent (then ID), namespace after namespace; with `max`, a part stops once
   * its contents reach that many bytes (one item at least), and its
   * X-Kurobako-Next header is the cursor for the rest (`after`). Each part is
   * a whole backup of its own items: restore them in any number of requests.
   */
  const archiveOf = async (
    c: AppContext,
    refs: NamespaceRef[],
    format: ArchiveFormat,
    { since, max, after }: { since: number | null; max: number | null; after: Cursor | null },
    filename: string,
  ) => {
    const { blobs } = platformOf(c);
    const manifest: Manifest = {
      kurobako: "backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      namespaces: [],
    };
    const entries: ArchiveEntry[] = [];
    let total = 0;
    let last: Omit<Cursor, "part"> | null = null;
    let more = false;
    const ordered = [...refs].sort((a, b) => compare([a.space, a.name], [b.space, b.name]));
    for (const ref of ordered) {
      if (more) break;
      if (after && compare([ref.space, ref.name], [after.space, after.name]) < 0) continue;
      const stored = (await namespace(c, ref).list()) as StoredItem[];
      // Oldest first by when they were sent; items sent in the same
      // millisecond keep their order in the queue (the sort is stable).
      const eligible = [...stored]
        .reverse()
        .filter((item) => !readLimitedItem(item) && (since === null || changedAt(item) >= since))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      // Names unique across the whole namespace, so parts never clash.
      const taken = new Set<string>();
      const files = new Map<string, string>();
      for (const item of eligible) {
        const file = unique(fileNameOf(item), item.id, taken);
        taken.add(file);
        files.set(item.id, file);
      }
      // Where this part starts: right after the cursor's item or, should it
      // be gone, at the items sent when it was (some may come again, which a
      // restore skips; none is missed).
      let start = 0;
      if (after && ref.space === after.space && ref.name === after.name) {
        const at = eligible.findIndex((item) => item.id === after.id);
        start = at >= 0 ? at + 1 : eligible.findIndex((item) => item.createdAt >= after.createdAt);
        if (start < 0) start = eligible.length;
      }
      const items: ManifestItem[] = [];
      for (const item of eligible.slice(start)) {
        if (max !== null && entries.length > 0 && total + item.size > max) {
          more = true;
          break;
        }
        total += item.size;
        last = { space: ref.space, name: ref.name, createdAt: item.createdAt, id: item.id };
        const path = `${ref.space}/${ref.name}/${files.get(item.id)}`;
        items.push({
          id: item.id,
          kind: item.kind,
          createdAt: item.createdAt,
          ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
          expiresAt: item.expiresAt,
          size: item.size,
          path,
          ...(item.kind === "text" && item.name ? { name: item.name } : {}),
          ...("filename" in item ? { filename: item.filename, mime: item.mime } : {}),
          ...(item.kind === "sealed" ? { metadata: item.metadata } : {}),
        });
        entries.push({
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
      }
      // A namespace backed up alone is listed even when empty.
      if (items.length || refs.length === 1) manifest.namespaces.push({ ...ref, items });
    }
    // A namespace's backup with nothing in it is what a name that does not
    // exist answers too (see misses.ts); a later part may just be the end.
    if (refs.length === 1 && !entries.length && !after) c.set("miss", true);
    const part = (after?.part ?? 0) + 1;
    const next = more && last ? encodeCursor({ ...last, part }) : null;
    if (next) manifest.next = next;
    const manifestBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const archive = writeArchive(format, [
      {
        path: MANIFEST,
        size: manifestBytes.byteLength,
        modified: new Date(),
        open: async () => new Blob([manifestBytes]).stream(),
      },
      ...entries,
    ]);
    // Parts are numbered, so `curl -OJ` never writes one over another.
    const name = max !== null ? `${filename}-part${part}` : filename;
    return new Response(archive, {
      headers: {
        "Content-Type": CONTENT_TYPES[format],
        "Content-Disposition": `attachment; filename="${name}.${format}"`,
        "Cache-Control": "no-store",
        ...(next ? { "X-Kurobako-Next": next } : {}),
      },
    });
  };

  /** ?max=<bytes>&after=<cursor>: one part of a backup (see archiveOf). */
  const partOf = (c: AppContext) => {
    const rawMax = c.req.query("max");
    const max = rawMax === undefined ? null : Number(rawMax);
    if (max !== null && (!Number.isSafeInteger(max) || max < 1)) {
      return jsonError(c, 400, "max must be a number of bytes, such as 90000000.");
    }
    const rawAfter = c.req.query("after");
    const after = rawAfter ? decodeCursor(rawAfter) : null;
    if (rawAfter && !after)
      return jsonError(c, 400, "after must be the X-Kurobako-Next of a part.");
    return { max, after };
  };

  /** ?since=<date or time>: only items sent or changed since then. */
  const sinceOf = (c: AppContext): number | null | Response => {
    const raw = c.req.query("since");
    if (!raw) return null;
    const time = Date.parse(raw);
    return Number.isNaN(time)
      ? jsonError(c, 400, "since must be a date, such as 2026-10-01 or 2026-10-01T12:00:00Z.")
      : time;
  };

  // --- Import -------------------------------------------------------------

  const isManifest = (value: unknown): value is Manifest => {
    const manifest = value as Manifest;
    return (
      manifest?.kurobako === "backup" &&
      manifest.version === 1 &&
      Array.isArray(manifest.namespaces) &&
      manifest.namespaces.every((ns) => Array.isArray(ns?.items))
    );
  };

  /**
   * One item's contents into storage, by the rules of a send: texts must be
   * UTF-8, a file's type comes from its bytes. Null when it cannot be kept.
   */
  const restoredInput = async (
    c: AppContext,
    ref: NamespaceRef,
    item: ManifestItem,
    body: ReadableStream<Uint8Array>,
    size: number,
    uploaded: string[],
  ): Promise<SaveInput | null> => {
    const { blobs } = platformOf(c);
    const store = async (
      stream: ReadableStream<Uint8Array>,
      contentType: string,
      hashed: boolean,
    ) => {
      const object = objectKey(ref);
      const hash = hashed ? hashing(stream) : null;
      await blobs.put(object, hash?.stream ?? stream, size, contentType);
      uploaded.push(object);
      return { object, ...(hash ? { sha256: hash.digest() } : {}) };
    };

    if (ref.space === "sealed") {
      if (item.kind !== "sealed" || !SEALED_METADATA_PATTERN.test(item.metadata ?? "")) {
        return null;
      }
      if (size > config.maxFileBytes) return null;
      const { object } = await store(body, "application/octet-stream", false);
      return { kind: "sealed", metadata: item.metadata as string, object, size };
    }

    if (item.kind === "text") {
      if (size > config.maxTextBytes || size === 0) return null;
      if (size <= config.inlineTextBytes) {
        const bytes = await readAll(body);
        try {
          const text = strictUtf8().decode(bytes);
          const sha256 = sha256Of(bytes);
          return { kind: "text", text, size, sha256 };
        } catch {
          return null;
        }
      }
      const external = validatedText({ body, size, head: new Uint8Array() });
      const { object, sha256 } = await store(external.upload.body, TEXT_MIME, true);
      try {
        external.validate();
      } catch (error) {
        if (error instanceof InvalidUtf8Error) return null;
        throw error;
      }
      const input = external.input;
      return input.kind === "text" && "preview" in input
        ? { kind: "text", preview: input.preview, object, size, sha256 }
        : null;
    }

    if (item.kind === "image" || item.kind === "file") {
      if (size > config.maxFileBytes || size === 0) return null;
      const { head, body: rest } = await peek(body, SIGNATURE_BYTES);
      const described = describePlainFile({ body: rest, size, head }, item.filename ?? null);
      if (described.kind !== "image" && described.kind !== "file") return null;
      const { object, sha256 } = await store(rest, described.mime, true);
      return {
        kind: described.kind,
        mime: described.mime,
        filename: described.filename,
        object,
        size,
        ...(sha256 ? { sha256 } : {}),
      };
    }
    return null;
  };

  /**
   * Restores what an archive holds. With `into`, the archive must hold one
   * namespace, restored into that one; an encrypted namespace only takes its
   * own items back, since only its key opens them.
   */
  const importArchive = async (
    c: AppContext,
    into: NamespaceRef | null,
    maxItems: number | null,
  ) => {
    const body = c.req.raw.body;
    if (!body) return jsonError(c, 400, "Send a zip or tar made by a Kurobako backup.");
    const { blobs } = platformOf(c);
    const sizes = new Map<string, number>();
    const owners = new Map<string, { ref: NamespaceRef; item: ManifestItem }>();
    const batches = new Map<string, { ref: NamespaceRef; items: Restored[] }>();
    const uploaded: string[] = [];
    let manifest: Manifest | null = null;
    let rejected = 0;
    try {
      for await (const entry of readArchive(body, (path) => sizes.get(path))) {
        if (!manifest) {
          if (entry.path !== MANIFEST) {
            return jsonError(c, 400, "This archive has no Kurobako manifest first.");
          }
          // Read whole, so held to what a namespace's manifest can need; the
          // admin's, for the whole instance, is trusted.
          if (maxItems !== null && entry.size > MANIFEST_BYTES_PER_ITEM * (maxItems + 1)) {
            return jsonError(c, 413, "This manifest is larger than a namespace's can be.");
          }
          const parsed: unknown = JSON.parse(new TextDecoder().decode(await readAll(entry.body)));
          if (!isManifest(parsed)) return jsonError(c, 400, "Not a Kurobako backup manifest.");
          manifest = parsed;
          if (into && manifest.namespaces.length !== 1) {
            return jsonError(c, 400, "A namespace takes a backup of one namespace.");
          }
          for (const ns of manifest.namespaces) {
            const ref = into ?? { space: ns.space, name: ns.name };
            const valid = ref.space === "sealed" ? sealedName(ref.name) : plainName(ref.name);
            if (!valid || (ref.space === "sealed") !== (ns.space === "sealed")) {
              return jsonError(c, 400, `${ns.space}/${ns.name} cannot be restored here.`);
            }
            if (ref.space === "sealed" && ref.name !== ns.name) {
              return jsonError(c, 400, "Encrypted items only open in their own namespace.");
            }
            if (maxItems !== null && ns.items.length > maxItems) {
              return jsonError(c, 413, `A namespace holds at most ${maxItems} items.`);
            }
            for (const item of ns.items) {
              sizes.set(item.path, item.size);
              owners.set(item.path, { ref, item });
            }
          }
          // Room for the whole backup, as if nothing in it were here yet.
          const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
          const full = await storageFull(c, total);
          if (full) return full;
          continue;
        }
        const owner = owners.get(entry.path);
        // Not in the manifest: passed over (the reader skips its bytes).
        if (!owner) continue;
        const { ref, item } = owner;
        const input = ITEM_ID.test(item.id)
          ? await restoredInput(c, ref, item, entry.body, entry.size, uploaded)
          : null;
        if (!input) {
          rejected += 1;
          continue;
        }
        const createdAt = Number.isNaN(Date.parse(item.createdAt))
          ? new Date().toISOString()
          : new Date(item.createdAt).toISOString();
        const updatedAt =
          item.updatedAt && !Number.isNaN(Date.parse(item.updatedAt))
            ? new Date(item.updatedAt).toISOString()
            : undefined;
        const expiresAt =
          item.expiresAt && !Number.isNaN(Date.parse(item.expiresAt))
            ? new Date(item.expiresAt).toISOString()
            : null;
        const key = objectName(ref);
        const batch = batches.get(key) ?? { ref, items: [] };
        batch.items.push({
          input,
          id: item.id,
          createdAt,
          ...(updatedAt ? { updatedAt } : {}),
          expiresAt,
          ...(item.kind === "text" && typeof item.name === "string" ? { name: item.name } : {}),
        });
        batches.set(key, batch);
      }
      if (!manifest) return jsonError(c, 400, "This archive is empty.");
    } catch (error) {
      await blobs.delete(uploaded);
      return jsonError(c, 400, `Could not read the archive: ${(error as Error).message}`);
    }

    let restored = 0;
    let skipped = 0;
    for (const { ref, items } of batches.values()) {
      const result = await namespace(c, ref).restore(
        ref,
        items,
        into ? await writeVerifier(c) : undefined,
      );
      restored += result.restored;
      skipped += items.length - result.restored;
      if (result.skipped.length) await blobs.delete(result.skipped);
    }
    return c.json({ restored, skipped, rejected, namespaces: batches.size });
  };

  // --- Routes -------------------------------------------------------------

  // The admin's, for the whole instance; /a/* already asks for the admin key.
  // First, or /:namespace/zip would take /a/zip.
  if (config.adminKey) {
    for (const format of FORMATS) {
      app.get(`${ADMIN_PATH}/${format}`, async (c) => {
        const since = sinceOf(c);
        if (since instanceof Response) return since;
        const part = partOf(c);
        if (part instanceof Response) return part;
        const refs = await hub(c).allNamespaces();
        return archiveOf(c, refs, format, { since, ...part }, `kurobako-${day(new Date())}`);
      });
    }
    app.on(["POST", "PUT"], `${ADMIN_PATH}/import`, (c) => importArchive(c, null, null));
  }

  for (const space of SPACES) {
    const { inNamespace } = namespaceOf(space);
    for (const format of FORMATS) {
      app.get(
        `${space.prefix}/${format}`,
        inNamespace(async (c, ref) => {
          const since = sinceOf(c);
          if (since instanceof Response) return since;
          const part = partOf(c);
          if (part instanceof Response) return part;
          const name = `${ref.name}-${day(new Date())}`;
          return archiveOf(c, [ref], format, { since, ...part }, name);
        }),
      );
    }
    // POST or PUT: `curl -T backup.zip <ns>/import` puts, and must not send a
    // file named "import" (registered before the namespace's own routes).
    app.on(
      ["POST", "PUT"],
      `${space.prefix}/import`,
      inNamespace(async (c, ref) => {
        const refused = (await refuseSend(c)) ?? (await refuseWrite(c, ref));
        if (refused) return refused;
        return importArchive(c, ref, config.maxItems);
      }),
    );
  }
};
