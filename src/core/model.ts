// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

type CommonItem = {
  id: string;
  createdAt: string;
  /** Last content or metadata change. Absent until an item changes. */
  updatedAt?: string;
  expiresAt: string | null;
  size: number;
  /** Deleted by the first read of its content. Absent means false. */
  burn?: true;
  /** Remaining consuming reads; absent means unlimited. `burn` is the legacy one-read form. */
  readsLeft?: number;
  /**
   * SHA-256 of the contents (hex), to spot the same contents sent again.
   * Never shown, and never kept for burn-after-reading or encrypted items.
   */
  sha256?: string;
};

type TextItemBase = CommonItem & {
  kind: "text";
  mime: "text/plain; charset=utf-8";
  /** A name given to the text; without one, it goes by the start of the text. */
  name?: string;
};

/** A small text kept directly in the namespace's SQLite database. */
export type InlineTextItem = TextItemBase & {
  text: string;
};

/** A larger text kept in the blob store, with only a list preview in SQLite. */
export type ExternalTextItem = TextItemBase & {
  /** Blob store key. */
  object: string;
  /** Absent for burn-after-reading items, whose contents must remain hidden. */
  preview?: string;
};

export type TextItem = InlineTextItem | ExternalTextItem;

/** Longest name a text can be given. */
export const TEXT_NAME_MAX_CHARS = 200;

/**
 * A text's default name: up to 80 Unicode code points. Only when truncated,
 * cut at the last word boundary and remove trailing punctuation. Clients use
 * the same convention; it is not part of decryption.
 */
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

/** The name an item is found by: a file's name, or a text's. */
export const nameOf = (item: StoredItem): string | null =>
  "filename" in item ? item.filename : item.kind === "text" ? (item.name ?? null) : null;

export type ImageItem = CommonItem & {
  kind: "image";
  mime: string;
  filename: string;
  /** Blob store key. */
  object: string;
};

/** Any other upload. Always served as an attachment, never inline. */
export type FileItem = CommonItem & {
  kind: "file";
  mime: string;
  filename: string;
  object: string;
};

/**
 * End-to-end encrypted content. The server only sees ciphertext; `metadata`
 * is a base64url ciphertext of the title, type and size, opened in the browser.
 */
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

/**
 * "<wrapped item key>.<encrypted metadata>", both base64url: each sealed item
 * has its own key, wrapped with the namespace key, so one item can be shared
 * without exposing the others.
 */
export const SEALED_METADATA_PATTERN = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{1,4096}$/;

/** A family of namespaces: plain (/name) or end-to-end encrypted (/e/id). */
export type SpaceKind = "plain" | "sealed";
export type NamespaceRef = { space: SpaceKind; name: string };

export const NAMESPACE_MAX_LENGTH = 64;
/**
 * Top-level paths that are not namespaces: the admin dashboard (/a),
 * encrypted namespaces (/e), shared items (/i) and system routes (/k).
 * Static files and JSON documents have a dot, which names never do.
 */
export const RESERVED_NAMESPACES = new Set(["e", "i", "k", "v"]);

/**
 * Share tokens: the namespace's slot (two characters, see routing.ts), then
 * 72 random bits in 12 base64url characters. Far beyond guessing through the
 * server, and short; the slot is shared by a few thousandths of all
 * namespaces, so it does not reveal which one.
 */
export const SHARE_TOKEN_BYTES = 9;
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{14}$/;
export const NAMESPACE_PATTERN = new RegExp(
  `^[a-z0-9](?:[a-z0-9_-]{0,${NAMESPACE_MAX_LENGTH - 2}}[a-z0-9])?$`,
);
/** Sealed namespace IDs are derived in the browser from the secret name. */
export const SEALED_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Longest secret name accepted for an end-to-end encrypted namespace. */
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

/** A namespace's path; `site` is the site's own (AppConfig.basePath), "" at the root. */
export const namespacePath = (site: string, { space, name }: NamespaceRef) =>
  space === "sealed" ? `${site}/e/${name}` : `${site}/${encodeURIComponent(name)}`;

/** A unique key for a namespace; the two spaces never collide. */
export const objectName = ({ space, name }: NamespaceRef) => `${space}:${name}`;

/**
 * Item IDs are short enough to type: six lowercase letters, unique within
 * their namespace. Being letters only, an ID never looks like a position.
 */
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

/**
 * An item as JSON. Where to read it follows from where it is listed:
 * <ns>/<id> serves its contents as they are (and consumes a
 * burn-after-reading item), <ns>/<id>/d saves them under their name.
 */
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

/** What the namespace's JSON and live updates show for an item. */
export const publicItem = (item: StoredItem) => exposeItem(item);

/** Texts longer than this go out as a preview in lists; the rest is fetched on demand. */
export const TEXT_PREVIEW_CHARS = 280;

/**
 * The list form the page uses: like publicItem, but a long text only carries
 * a preview. Every change sends the queue to every viewer, so this keeps
 * those messages small even with large texts.
 */
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

/**
 * A shared item, without its ID: nothing that leads back to the namespace.
 * Its contents are at /i/<token>/c, a download at /i/<token>/d.
 */
export const sharedItem = (item: StoredItem) => {
  const { id: _id, ...rest } = exposeItem(item);
  return rest;
};
