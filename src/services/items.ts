// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Keeping an item's contents: small texts stay in SQLite; files and larger
// texts stream to the blob store, then the namespace records the item. Sends,
// edits and restored backups all go through here; reading the request is the
// routes' part (api/uploads.ts, api/archives.ts).
import { createHash } from "node:crypto";
import { BUNDLE_MIME, isBundle } from "../client/shared/bundle.js";
import { detectMedia, safeFileName, safeMediaName } from "../core/media";
import { type NamespaceRef, type StoredItem, TEXT_PREVIEW_CHARS } from "../core/model";
import type { ItemRef, Saved, SaveInput } from "../core/namespace";
import type { AccessEvent } from "../core/visits";
import type { Deps } from "./deps";

/** A file-backed item before its bytes are in the blob store. */
export type ObjectInput = DistributiveOmit<
  Extract<SaveInput, { object: string }>,
  "object" | "size"
>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const TEXT_MIME = "text/plain; charset=utf-8";

export class InvalidUtf8Error extends Error {}

/** A decoder that refuses anything but UTF-8, as texts must be (a new one each time: it keeps state). */
export const strictUtf8 = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Where an item's contents go in the blob store: never shown, never reused. */
export const objectKey = (ref: NamespaceRef) => `${ref.space}/${ref.name}/${crypto.randomUUID()}`;

/** SHA-256 of bytes, as the server keeps it to spot the same contents sent again. */
export const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The stream as it is, its SHA-256 worked out on the way through: `digest()`
 * once it has been read whole.
 */
export const hashing = (stream: ReadableStream<Uint8Array>) => {
  const hash = createHash("sha256");
  return {
    stream: stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          hash.update(chunk);
          controller.enqueue(chunk);
        },
      }),
    ),
    digest: () => hash.digest("hex"),
  };
};

/**
 * A file upload, streamed to the blob store without holding it in memory.
 * The store needs the length up front and fails if the body does not match.
 */
export type Upload = {
  body: ReadableStream;
  size: number;
  /** The first bytes, enough to recognize an image, read before uploading. */
  head: Uint8Array;
};

/** Reads the first `length` bytes and returns a stream that still yields everything. */
export const peek = async (body: ReadableStream<Uint8Array>, length: number) => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  let done = false;
  while (read < length && !done) {
    const result = await reader.read();
    done = result.done;
    if (result.value) {
      chunks.push(result.value);
      read += result.value.byteLength;
    }
  }
  const head = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    head.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const result = await reader.read();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { head: head.subarray(0, length), body: rest };
};

/** Validates streamed UTF-8 while retaining just enough text for list previews. */
export const validatedText = (upload: Upload) => {
  const decoder = strictUtf8();
  const input: ObjectInput = { kind: "text", preview: "" };
  let invalid = false;
  const appendPreview = (value: string) => {
    if (input.kind === "text" && input.preview.length < TEXT_PREVIEW_CHARS) {
      input.preview += value.slice(0, TEXT_PREVIEW_CHARS - input.preview.length);
    }
  };
  const body = upload.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!invalid) {
          try {
            appendPreview(decoder.decode(chunk, { stream: true }));
          } catch {
            // Keep the fixed-length upload flowing; it is deleted below before
            // any namespace row can point at it.
            invalid = true;
          }
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (!invalid) {
          try {
            appendPreview(decoder.decode());
          } catch {
            invalid = true;
          }
        }
      },
    }),
  );
  return {
    upload: { ...upload, body },
    input,
    validate: () => {
      if (invalid) throw new InvalidUtf8Error();
    },
  };
};

/** The type comes from the bytes themselves, never from what the client claims. */
export const describePlainFile = (upload: Upload, filename: string | null): ObjectInput => {
  const detected = detectMedia(upload.head);
  // A send without a name gets a default one, which never renames an item.
  const named = filename !== null;
  // Recognized images are shown inline; video and audio keep their type so pages
  // can play them (still a "file" in the queue); anything else is a download.
  if (detected) {
    return {
      kind: detected.kind === "image" ? "image" : "file",
      mime: detected.mime,
      filename: safeMediaName(filename ?? "file", detected.extension, detected.kind),
      named,
    };
  }
  // A bundle (texts and files sent as one tar) keeps its type, so pages can
  // show what it holds; it is downloaded as the tar it is.
  if (isBundle(upload.head)) {
    const name = safeFileName(filename ?? "bundle");
    return {
      kind: "file",
      mime: BUNDLE_MIME,
      filename: name.toLowerCase().endsWith(".tar") ? name : `${name}.tar`,
      named,
    };
  }
  return {
    kind: "file",
    mime: "application/octet-stream",
    filename: safeFileName(filename ?? "file"),
    named,
  };
};

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
