// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

type CommonItem = {
  id: string;
  createdAt: string;
  /** Absent until the item changes. */
  updatedAt?: string;
  expiresAt: string | null;
  size: number;
  burn?: true;
  /** Absent: unlimited. `burn` is the older one-read form. */
  readsLeft?: number;
  /** Never kept for burn-after-reading or encrypted items, so it cannot reveal them. */
  sha256?: string;
};

type TextItemBase = CommonItem & {
  kind: "text";
  mime: "text/plain; charset=utf-8";
  /** Without one, a text goes by its start. */
  name?: string;
};

export type InlineTextItem = TextItemBase & {
  text: string;
};

/** Only a preview stays in SQLite. */
export type ExternalTextItem = TextItemBase & {
  object: string;
  /** Absent for burn-after-reading items, whose contents must remain hidden. */
  preview?: string;
};

export type TextItem = InlineTextItem | ExternalTextItem;

export const TEXT_NAME_MAX_CHARS = 200;

/** Clients use the same convention; it is not part of decryption. */
export const DEFAULT_NAME_CHARS = 80;
export const defaultTextName = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  let end = 0;
  let count = 0;
  for (const point of flat) {
    if (count === DEFAULT_NAME_CHARS) break;
    end += point.length;
    count += 1;
  }
  if (end === flat.length) return flat;
  const cut = flat.slice(0, end);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?–—-]+$/u, "");
};

export const nameOf = (item: StoredItem): string | null =>
  "filename" in item ? item.filename : item.kind === "text" ? (item.name ?? null) : null;

export type ImageItem = CommonItem & {
  kind: "image";
  mime: string;
  filename: string;
  object: string;
};

/** Always an attachment, so it never runs in the site's origin. */
export type FileItem = CommonItem & {
  kind: "file";
  mime: string;
  filename: string;
  object: string;
};

/** The server only sees ciphertext; the title, type and size are in `metadata`. */
export type SealedItem = CommonItem & {
  kind: "sealed";
  metadata: string;
  object: string;
};

export type StoredItem = TextItem | ImageItem | FileItem | SealedItem;
export const readLimitedItem = (item: StoredItem): boolean =>
  item.burn === true || item.readsLeft !== undefined;
export const lastRead = (item: StoredItem): boolean => item.burn === true || item.readsLeft === 1;
export type ObjectItem = ExternalTextItem | ImageItem | FileItem | SealedItem;

export const hasObject = (item: StoredItem): item is ObjectItem => "object" in item;

/** Each item has its own key, wrapped with the namespace's, so one can be shared alone. */
export const SEALED_METADATA_PATTERN = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{1,4096}$/;

export type SpaceKind = "plain" | "sealed";
export type NamespaceRef = { space: SpaceKind; name: string };

export const NAMESPACE_MAX_LENGTH = 64;
/** Static files and JSON have a dot, which names never do, so they need no entry. */
export const RESERVED_NAMESPACES = new Set(["e", "i", "k", "v"]);

/**
 * The slot (two characters, see routing.ts) routes a link to its server; 72
 * random bits make it unguessable. A slot is shared by thousands of namespaces,
 * so it reveals none.
 */
export const SHARE_TOKEN_BYTES = 9;
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{14}$/;
export const NAMESPACE_PATTERN = new RegExp(
  `^[a-z0-9](?:[a-z0-9_-]{0,${NAMESPACE_MAX_LENGTH - 2}}[a-z0-9])?$`,
);
/** Derived in the browser from the secret name, which never reaches the server. */
export const SEALED_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const SEALED_NAME_MAX_LENGTH = 256;

export const plainName = (raw: string): string | null => {
  const normalized = raw.trim().toLowerCase();
  return normalized === raw &&
    NAMESPACE_PATTERN.test(normalized) &&
    !RESERVED_NAMESPACES.has(normalized)
    ? normalized
    : null;
};
export const sealedName = (raw: string): string | null =>
  SEALED_ID_PATTERN.test(raw) ? raw : null;

export const namespacePath = (site: string, { space, name }: NamespaceRef) =>
  space === "sealed" ? `${site}/e/${name}` : `${site}/${encodeURIComponent(name)}`;

/** The two spaces never collide. */
export const objectName = ({ space, name }: NamespaceRef) => `${space}:${name}`;

/** Short enough to type, and letters only so an ID never looks like a position. */
const ITEM_ID_LETTERS = "abcdefghijklmnopqrstuvwxyz";
export const ITEM_ID_LENGTH = 6;

export const newItemId = (): string => {
  let id = "";
  while (id.length < ITEM_ID_LENGTH) {
    // Rejecting the top values keeps every letter equally likely.
    for (const byte of crypto.getRandomValues(new Uint8Array(ITEM_ID_LENGTH))) {
      if (byte < 256 - (256 % ITEM_ID_LETTERS.length) && id.length < ITEM_ID_LENGTH) {
        id += ITEM_ID_LETTERS[byte % ITEM_ID_LETTERS.length];
      }
    }
  }
  return id;
};

const exposeItem = (item: StoredItem) => {
  const {
    object: _object,
    sha256: _sha256,
    text,
    ...metadata
  } = item as StoredItem & { object?: string; text?: string };
  // Burn-after-reading content is only handed out by a consuming read.
  if (readLimitedItem(item) || item.kind !== "text" || !("text" in item)) return metadata;
  return { ...metadata, text };
};

export const publicItem = (item: StoredItem) => exposeItem(item);

export const TEXT_PREVIEW_CHARS = 280;

/** Every change sends the queue to every viewer, so long texts go as previews. */
export const summaryItem = (item: StoredItem) => {
  const shown = publicItem(item);
  if (
    item.kind !== "text" ||
    readLimitedItem(item) ||
    !("text" in item) ||
    item.text.length <= TEXT_PREVIEW_CHARS
  ) {
    return shown;
  }
  const { text: _text, ...rest } = shown as typeof shown & { text?: string };
  return { ...rest, preview: item.text.slice(0, TEXT_PREVIEW_CHARS) };
};

/** Without its ID: nothing that leads back to the namespace. */
export const sharedItem = (item: StoredItem, summary = false) => {
  const { id: _id, ...rest } = summary ? summaryItem(item) : publicItem(item);
  return rest;
};
