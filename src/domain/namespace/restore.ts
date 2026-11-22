// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What a backup's item does to an item already here, by the same ID.
import { hasObject, type StoredItem } from "../model";
import { type Rename, renamedItem, replacedItem, type SaveInput } from "./queue";

export type Incoming = {
  input: SaveInput;
  updatedAt?: string;
  name?: string;
};

/**
 * Restoring the same backup twice changes nothing: only a newer change is
 * taken. Same contents take the backup's name; a text (or sealed body) takes
 * its contents. `replaced`: the existing item, when its object is no longer used;
 * `usesUpload`: whether the backup's uploaded object (if any) is kept.
 * null: nothing changes, and the uploaded object is unused.
 */
export const mergeRestored = (
  existing: StoredItem,
  { input, updatedAt, name }: Incoming,
): { item: StoredItem; replaced: StoredItem | null; usesUpload: boolean } | null => {
  const currentChange = Date.parse(existing.updatedAt ?? existing.createdAt);
  const incomingChange = updatedAt ? Date.parse(updatedAt) : Number.NEGATIVE_INFINITY;
  if (incomingChange <= currentChange) return null;
  // A sealed body has no digest: changing only its metadata could pair a new
  // revision with the old ciphertext.
  const sameContents =
    existing.kind === input.kind &&
    existing.size === input.size &&
    existing.kind !== "sealed" &&
    Boolean(existing.sha256 && input.sha256 && existing.sha256 === input.sha256);
  if (sameContents) {
    const change: Rename | null =
      input.kind === "text"
        ? { name: name ?? "" }
        : input.kind === "image" || input.kind === "file"
          ? { name: input.filename }
          : null;
    if (!change) return null;
    const renamed = renamedItem(existing, change);
    return "error" in renamed
      ? null
      : { item: { ...renamed, updatedAt }, replaced: null, usesUpload: false };
  }
  const editable =
    (existing.kind === "text" && input.kind === "text") ||
    (existing.kind === "sealed" && input.kind === "sealed");
  if (!editable || !updatedAt) return null;
  const replaced = replacedItem(existing, input, updatedAt);
  if ("error" in replaced) return null;
  const item = replaced.kind === "text" && name !== undefined ? { ...replaced, name } : replaced;
  const objectGone = hasObject(existing) && (!hasObject(item) || item.object !== existing.object);
  return { item, replaced: objectGone ? existing : null, usesUpload: true };
};
