// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Sends, edits and restores all store through here, so no blob is left without its item.
import { hashing, type ObjectInput, objectKey, TEXT_MIME, type Upload } from "../core/contents";
import type { NamespaceRef, StoredItem } from "../core/model";
import type { ItemRef, Saved, SaveInput } from "../core/namespace";
import type { AccessEvent } from "../core/visits";
import type { Deps } from "./deps";

type Defer = (work: Promise<unknown>) => void;

export type SendOptions = {
  burn: boolean;
  visitor: AccessEvent;
  /** null: the instance default. */
  expiresInSeconds: number | null;
  /** null: no limit. */
  reads: number | null;
  verifier: string | null;
  view: { token: string; envelope?: string } | undefined;
  deduplicate: boolean;
  /** Not told of its own send. */
  pushSkip: string | null;
};

export type EditOptions = Pick<SendOptions, "visitor" | "verifier">;

export type ReplaceResult = { item: StoredItem } | { error: string; conflict?: true } | null;

const contentTypeOf = (input: ObjectInput) =>
  input.kind === "sealed"
    ? "application/octet-stream"
    : input.kind === "text"
      ? TEXT_MIME
      : input.mime;

export const createItems = ({ namespace, platform }: Pick<Deps, "namespace" | "platform">) => {
  /** Plain contents are hashed to spot the same contents sent again; ciphertext never matches. */
  const storeObject = async (ref: NamespaceRef, upload: Upload, input: ObjectInput) => {
    // Never shown: the item's ID is the namespace's.
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
      // Already there: the upload is a copy nothing points at.
      if (saved.existing) defer(discard(object));
      return saved;
    } catch (error) {
      defer(discard(object));
      throw error;
    }
  };

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
    // null or an error: nothing committed. A thrown RPC may have committed, so the blob stays.
    if (!result || "error" in result) defer(discard(object));
    return result;
  };

  return { storeObject, save, saveObject, replace, replaceObject };
};
