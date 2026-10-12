// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Keeping an item's contents: small texts stay in SQLite; files and larger
// texts stream to the blob store, then the namespace records the item. Sends,
// edits and restored backups all go through here; reading the request is the
// routes' part (api/uploads.ts, api/archives.ts), and what the bytes are is
// core/contents.ts.
import { hashing, type ObjectInput, objectKey, TEXT_MIME, type Upload } from "../core/contents";
import type { NamespaceRef, StoredItem } from "../core/model";
import type { ItemRef, Saved, SaveInput } from "../core/namespace";
import type { AccessEvent } from "../core/visits";
import type { Deps } from "./deps";

/** Work that may finish after the response, such as deleting a blob nothing points at. */
type Defer = (work: Promise<unknown>) => void;

/** How a send asks for its item to be kept (headers, in api/uploads.ts). */
export type SendOptions = {
  /** Deleted by its first read. */
  burn: boolean;
  visitor: AccessEvent;
  /** Its lifetime; null for the instance default. */
  expiresInSeconds: number | null;
  /** How many reads it takes; null for no limit. */
  reads: number | null;
  /** The write key's SHA-256, for an encrypted namespace. */
  verifier: string | null;
  /** The shared view to add it to, and its envelope there. */
  view: { token: string; envelope?: string } | undefined;
  /** Whether the same contents sent again bring the existing item to the top. */
  deduplicate: boolean;
  /** The sending device's push subscription, not told of its own send. */
  pushSkip: string | null;
};

/** What an edit asks for: who edits, with which key. */
export type EditOptions = Pick<SendOptions, "visitor" | "verifier">;

export type ReplaceResult = { item: StoredItem } | { error: string; conflict?: true } | null;

const contentTypeOf = (input: ObjectInput) =>
  input.kind === "sealed"
    ? "application/octet-stream"
    : input.kind === "text"
      ? TEXT_MIME
      : input.mime;

export const createItems = ({ namespace, platform }: Pick<Deps, "namespace" | "platform">) => {
  /**
   * Streams contents into the blob store under a new key. Plain files are
   * hashed on the way, so the same contents sent again can be spotted;
   * encrypted ones never match, so they are not.
   */
  const storeObject = async (ref: NamespaceRef, upload: Upload, input: ObjectInput) => {
    // The file's own key, never shown: the item's ID is picked by the namespace.
    const object = objectKey(ref);
    const hashed = input.kind === "sealed" ? null : hashing(upload.body);
    await platform.blobs.put(
      object,
      hashed?.stream ?? upload.body,
      upload.size,
      contentTypeOf(input),
    );
    const stored = {
      ...input,
      object,
      size: upload.size,
      ...(hashed ? { sha256: hashed.digest() } : {}),
    };
    return stored as SaveInput;
  };
  const discard = (object: string) => platform.blobs.delete([object]);

  /** Records an item whose contents are already where they belong (an inline text). */
  const save = async (ref: NamespaceRef, input: SaveInput, options: SendOptions) =>
    (await namespace(ref).save(
      ref,
      input,
      options.burn,
      options.visitor,
      options.expiresInSeconds,
      options.reads,
      options.verifier,
      options.view,
      options.deduplicate,
      options.pushSkip,
    )) as Saved;

  /** Streams contents into the blob store, then records their key in the namespace. */
  const saveObject = async (
    ref: NamespaceRef,
    upload: Upload,
    input: ObjectInput,
    options: SendOptions,
    defer: Defer,
    validate?: () => void,
  ): Promise<Saved> => {
    const stored = await storeObject(ref, upload, input);
    const object = (stored as { object: string }).object;
    try {
      validate?.();
      const saved = await save(ref, stored, options);
      // Already there: the file just uploaded is a copy nothing points at.
      if (saved.existing) defer(discard(object));
      return saved;
    } catch (error) {
      // Nothing points at the file anymore.
      defer(discard(object));
      throw error;
    }
  };

  /** Replaces an item's contents with ones already where they belong (an inline text). */
  const replace = async (
    ref: NamespaceRef,
    item: ItemRef,
    expected: string,
    input: SaveInput,
    options: EditOptions,
  ) =>
    (await namespace(ref).replace(
      item,
      input,
      expected,
      options.visitor,
      options.verifier,
    )) as ReplaceResult;

  /** Uploads replacement bytes, deleting them only when they are certainly unreferenced. */
  const replaceObject = async (
    ref: NamespaceRef,
    item: ItemRef,
    expected: string,
    upload: Upload,
    input: ObjectInput,
    options: EditOptions,
    defer: Defer,
    validate?: () => void,
  ): Promise<ReplaceResult> => {
    const stored = await storeObject(ref, upload, input);
    const object = (stored as { object: string }).object;
    try {
      validate?.();
    } catch (error) {
      defer(discard(object));
      throw error;
    }
    const result = await replace(ref, item, expected, stored, options);
    // A null or error answer guarantees the namespace did not commit. A thrown
    // RPC does not: leave the blob, since the committed row may point at it.
    if (!result || "error" in result) defer(discard(object));
    return result;
  };

  return { storeObject, save, saveObject, replace, replaceObject };
};
