// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Receiving items: small texts stay in SQLite; files and larger texts stream
// to the blob store.
import { createHash } from "node:crypto";
import { detectMedia, SIGNATURE_BYTES, safeFileName, safeMediaName } from "../image";
import {
  type NamespaceRef,
  publicItem,
  SEALED_METADATA_PATTERN,
  type StoredItem,
  TEXT_PREVIEW_CHARS,
} from "../model";
import type { ItemRef, Saved, SaveInput } from "../namespace";
import { type Api, type AppContext, jsonError, readLimited, writeVerifier } from "./context";

/** A file-backed item before its bytes are in the blob store. */
export type ObjectInput = DistributiveOmit<
  Extract<SaveInput, { object: string }>,
  "object" | "size"
>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const BURN_HEADER_VALUES = new Set(["1", "true", "yes"]);
const MAX_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;
const MAX_READS = 1_000_000;
/** Request types stored as text: what the page sends, and what `curl -d` sends. */
const TEXT_TYPES = new Set(["text/plain", "application/x-www-form-urlencoded"]);
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

/** The name a send gives, or null when it gives none. */
export const decodeFilename = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** `Burn: 1` on a send: the item is deleted by its first read. Short to type: `-H burn:1`. */
export const burnRequested = (c: AppContext) =>
  BURN_HEADER_VALUES.has((c.req.header("burn") ?? "").trim().toLowerCase());

/** A send's requested lifetime, or a validation response. Null means the instance default. */
const requestedExpiry = (c: AppContext, itemTtlMs: number): number | null | Response => {
  const raw = c.req.header("expires-in");
  if (raw === undefined) return null;
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    return jsonError(c, 400, "Expires-In must be a positive integer of seconds.");
  }
  const seconds = Number(raw.trim());
  const max = itemTtlMs ? itemTtlMs / 1000 : MAX_EXPIRES_IN_SECONDS;
  if (!Number.isSafeInteger(seconds) || seconds > max) {
    return jsonError(c, 400, `Expires-In must be at most ${max} seconds.`);
  }
  return seconds;
};

/** `Burn: 1` is the one-read spelling of `Reads: 1`. */
const requestedReads = (c: AppContext): number | null | Response => {
  const raw = c.req.header("reads");
  if (raw === undefined) return null;
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    return jsonError(c, 400, "Reads must be a positive integer.");
  }
  const count = Number(raw.trim());
  if (!Number.isSafeInteger(count) || count > MAX_READS) {
    return jsonError(c, 400, `Reads must be at most ${MAX_READS}.`);
  }
  if (burnRequested(c) && count !== 1) {
    return jsonError(c, 400, "Burn: 1 conflicts with Reads greater than one.");
  }
  return count;
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

const streamedBody = async (c: AppContext, limit: number): Promise<Upload | Response> => {
  const size = Number(c.req.header("content-length") ?? Number.NaN);
  if (size === 0 || !c.req.raw.body) return jsonError(c, 400, "The content is empty.");
  if (!Number.isSafeInteger(size) || size < 0) {
    return jsonError(c, 411, "A Content-Length header is required.");
  }
  if (size > limit) return jsonError(c, 413, `The limit is ${limit} bytes.`);
  const { head, body } = await peek(c.req.raw.body, SIGNATURE_BYTES);
  return { body, size, head };
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

/** Reads a (small) request body, stopping at `limit`. */
const readBody = async (c: AppContext, limit: number) => {
  const bytes = await readLimited(c, limit);
  if (!bytes) return jsonError(c, 413, `The limit is ${limit} bytes.`);
  if (bytes.byteLength === 0) return jsonError(c, 400, "The content is empty.");
  return bytes;
};

/** The type comes from the bytes themselves, never from what the client claims. */
export const describePlainFile = (upload: Upload, filename: string | null): ObjectInput => {
  const detected = detectMedia(upload.head);
  // A send without a name gets a default one, which never renames an item.
  const named = filename !== null;
  // Recognized images are shown inline, and videos keep their type so pages
  // can play them (still a "file" in the queue); anything else is a download.
  if (detected) {
    return {
      kind: detected.kind === "image" ? "image" : "file",
      mime: detected.mime,
      filename: safeMediaName(filename ?? "file", detected.extension, detected.kind),
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

/** A send's answer: 201 for a new item, 200 for contents already there, now on top. */
const sentResponse = (c: AppContext, saved: Saved) =>
  saved.existing
    ? c.json({ ...publicItem(saved.item), existing: true }, 200)
    : c.json(publicItem(saved.item), 201);

export const createUploads = (api: Api) => {
  const { config, namespace, platformOf, later, record, visit } = api;
  const viewOf = (c: AppContext) => {
    const token = c.req.header("view-token");
    const envelope = c.req.header("view-envelope");
    return token ? { token, ...(envelope ? { envelope } : {}) } : undefined;
  };
  const deduplicate = (c: AppContext) => c.req.header("no-dedup") !== "1";

  /** Streams contents into the blob store, then records their key in the namespace. */
  const saveObject = async (
    c: AppContext,
    ref: NamespaceRef,
    upload: Upload,
    input: ObjectInput,
    validate?: () => void,
    expiresInSeconds: number | null = null,
    reads: number | null = null,
  ): Promise<Saved> => {
    // The file's own key, never shown: the item's ID is picked by the namespace.
    const object = objectKey(ref);
    const contentType =
      input.kind === "sealed"
        ? "application/octet-stream"
        : input.kind === "text"
          ? TEXT_MIME
          : input.mime;
    const { blobs } = platformOf(c);
    // Plain files are hashed on the way to storage, so the same contents sent
    // again can be spotted; encrypted ones never match, so they are not.
    const hashed = input.kind === "sealed" ? null : hashing(upload.body);
    await blobs.put(object, hashed?.stream ?? upload.body, upload.size, contentType);
    try {
      validate?.();
      const saved = (await namespace(c, ref).save(
        ref,
        { ...input, object, size: upload.size, ...(hashed ? { sha256: hashed.digest() } : {}) },
        burnRequested(c),
        visit(c),
        expiresInSeconds,
        reads,
        await writeVerifier(c),
        viewOf(c),
        deduplicate(c),
      )) as Saved;
      // Already there: the file just uploaded is a copy nothing points at.
      if (saved.existing) later(c, blobs.delete([object]));
      return saved;
    } catch (error) {
      // Nothing points at the file anymore.
      later(c, blobs.delete([object]));
      throw error;
    }
  };

  const uploadFile = async (c: AppContext, ref: NamespaceRef, filename: string | null) => {
    const expiresIn = requestedExpiry(c, config.itemTtlMs);
    if (expiresIn instanceof Response) return expiresIn;
    const reads = requestedReads(c);
    if (reads instanceof Response) return reads;
    const upload = await streamedBody(c, config.maxFileBytes);
    if (upload instanceof Response) return upload;
    const saved = await saveObject(
      c,
      ref,
      upload,
      describePlainFile(upload, filename),
      undefined,
      expiresIn,
      reads,
    );
    record(c, "sentFile");
    return sentResponse(c, saved);
  };

  const uploadPlain = async (c: AppContext, ref: NamespaceRef) => {
    const expiresIn = requestedExpiry(c, config.itemTtlMs);
    if (expiresIn instanceof Response) return expiresIn;
    const reads = requestedReads(c);
    if (reads instanceof Response) return reads;
    const contentType = (c.req.header("content-type") || "").split(";", 1)[0]?.trim().toLowerCase();
    if (!TEXT_TYPES.has(contentType ?? "")) {
      return uploadFile(c, ref, decodeFilename(c.req.header("x-filename")));
    }

    const declared = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isSafeInteger(declared) && declared > config.maxTextBytes) {
      return jsonError(c, 413, `The limit is ${config.maxTextBytes} bytes.`);
    }
    if (Number.isSafeInteger(declared) && declared > config.inlineTextBytes) {
      const upload = await streamedBody(c, config.maxTextBytes);
      if (upload instanceof Response) return upload;
      const external = validatedText(upload);
      try {
        const saved = await saveObject(
          c,
          ref,
          external.upload,
          external.input,
          external.validate,
          expiresIn,
          reads,
        );
        record(c, "sentText");
        return sentResponse(c, saved);
      } catch (error) {
        if (error instanceof InvalidUtf8Error) {
          return jsonError(c, 415, "Text must be UTF-8. Send files as application/octet-stream.");
        }
        throw error;
      }
    }

    const bytes = await readBody(c, config.maxTextBytes);
    if (bytes instanceof Response) return bytes;
    let text: string;
    try {
      text = strictUtf8().decode(bytes);
    } catch {
      return jsonError(c, 415, "Text must be UTF-8. Send files as application/octet-stream.");
    }
    let saved: Saved;
    if (bytes.byteLength > config.inlineTextBytes) {
      saved = await saveObject(
        c,
        ref,
        { body: new Blob([bytes]).stream(), size: bytes.byteLength, head: new Uint8Array() },
        { kind: "text", preview: text.slice(0, TEXT_PREVIEW_CHARS) },
        undefined,
        expiresIn,
        reads,
      );
    } else {
      saved = (await namespace(c, ref).save(
        ref,
        {
          kind: "text",
          text,
          size: bytes.byteLength,
          sha256: sha256Of(bytes),
        },
        burnRequested(c),
        visit(c),
        expiresIn,
        reads,
        await writeVerifier(c),
        viewOf(c),
        deduplicate(c),
      )) as Saved;
    }
    record(c, "sentText");
    return sentResponse(c, saved);
  };

  const uploadSealed = async (c: AppContext, ref: NamespaceRef) => {
    const expiresIn = requestedExpiry(c, config.itemTtlMs);
    if (expiresIn instanceof Response) return expiresIn;
    const reads = requestedReads(c);
    if (reads instanceof Response) return reads;
    const metadata = c.req.header("x-sealed-metadata") ?? "";
    if (!SEALED_METADATA_PATTERN.test(metadata)) {
      return jsonError(c, 400, "Missing or invalid X-Sealed-Metadata header.");
    }
    // The browser checks that ciphertext (contents plus IV and tag) fits.
    const upload = await streamedBody(c, config.maxFileBytes);
    if (upload instanceof Response) return upload;
    const saved = await saveObject(
      c,
      ref,
      upload,
      { kind: "sealed", metadata },
      undefined,
      expiresIn,
      reads,
    );
    record(c, "sentEncrypted");
    return sentResponse(c, saved);
  };

  type ReplaceResult = { item: StoredItem } | { error: string; conflict?: true } | null;

  /** Uploads replacement bytes, deleting them only when they are certainly unreferenced. */
  const replaceObject = async (
    c: AppContext,
    ref: NamespaceRef,
    item: ItemRef,
    expected: string,
    upload: Upload,
    input: ObjectInput,
    validate?: () => void,
  ): Promise<ReplaceResult> => {
    const object = objectKey(ref);
    const { blobs } = platformOf(c);
    const hashed = input.kind === "sealed" ? null : hashing(upload.body);
    const contentType = input.kind === "sealed" ? "application/octet-stream" : TEXT_MIME;
    await blobs.put(object, hashed?.stream ?? upload.body, upload.size, contentType);
    try {
      validate?.();
    } catch (error) {
      later(c, blobs.delete([object]));
      throw error;
    }
    const result = (await namespace(c, ref).replace(
      item,
      { ...input, object, size: upload.size, ...(hashed ? { sha256: hashed.digest() } : {}) },
      expected,
      visit(c),
      await writeVerifier(c),
    )) as ReplaceResult;
    // A null or error answer guarantees the namespace did not commit. A thrown
    // RPC does not: leave the blob, since the committed row may point at it.
    if (!result || "error" in result) later(c, blobs.delete([object]));
    return result;
  };

  const editResponse = (c: AppContext, result: ReplaceResult) => {
    if (!result) return jsonError(c, 404, "Item not found.");
    if ("error" in result) return jsonError(c, result.conflict ? 412 : 400, result.error);
    record(c, result.item.kind === "sealed" ? "sentEncrypted" : "sentText");
    return c.json(publicItem(result.item));
  };

  /** Replaces one text, using the same inline/blob and UTF-8 rules as a send. */
  const editText = async (c: AppContext, ref: NamespaceRef, item: ItemRef, expected: string) => {
    if (ref.space === "sealed") {
      const metadata = c.req.header("x-sealed-metadata") ?? "";
      if (!SEALED_METADATA_PATTERN.test(metadata)) {
        return jsonError(c, 400, "Missing or invalid X-Sealed-Metadata header.");
      }
      const upload = await streamedBody(c, config.maxFileBytes);
      if (upload instanceof Response) return upload;
      return editResponse(
        c,
        await replaceObject(c, ref, item, expected, upload, { kind: "sealed", metadata }),
      );
    }

    const contentType = (c.req.header("content-type") || "").split(";", 1)[0]?.trim().toLowerCase();
    if (!TEXT_TYPES.has(contentType ?? "")) {
      return jsonError(c, 415, "A text edit needs Content-Type: text/plain.");
    }
    const declared = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isSafeInteger(declared) && declared > config.maxTextBytes) {
      return jsonError(c, 413, `The limit is ${config.maxTextBytes} bytes.`);
    }
    if (Number.isSafeInteger(declared) && declared > config.inlineTextBytes) {
      const upload = await streamedBody(c, config.maxTextBytes);
      if (upload instanceof Response) return upload;
      const external = validatedText(upload);
      try {
        return editResponse(
          c,
          await replaceObject(
            c,
            ref,
            item,
            expected,
            external.upload,
            external.input,
            external.validate,
          ),
        );
      } catch (error) {
        if (error instanceof InvalidUtf8Error) {
          return jsonError(c, 415, "Text must be UTF-8. Send files as application/octet-stream.");
        }
        throw error;
      }
    }

    const bytes = await readBody(c, config.maxTextBytes);
    if (bytes instanceof Response) return bytes;
    let text: string;
    try {
      text = strictUtf8().decode(bytes);
    } catch {
      return jsonError(c, 415, "Text must be UTF-8. Send files as application/octet-stream.");
    }
    const result =
      bytes.byteLength > config.inlineTextBytes
        ? await replaceObject(
            c,
            ref,
            item,
            expected,
            { body: new Blob([bytes]).stream(), size: bytes.byteLength, head: new Uint8Array() },
            { kind: "text", preview: text.slice(0, TEXT_PREVIEW_CHARS) },
          )
        : ((await namespace(c, ref).replace(
            item,
            { kind: "text", text, size: bytes.byteLength, sha256: sha256Of(bytes) },
            expected,
            visit(c),
            await writeVerifier(c),
          )) as ReplaceResult);
    return editResponse(c, result);
  };

  return { editText, uploadFile, uploadPlain, uploadSealed };
};
