// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Receiving items: small texts stay in SQLite; files and larger texts stream
// to the blob store.
import { createHash } from "node:crypto";
import { detectImage, IMAGE_SIGNATURE_BYTES, safeFileName, safeImageName } from "../image";
import {
  type NamespaceRef,
  publicItem,
  SEALED_METADATA_PATTERN,
  TEXT_PREVIEW_CHARS,
} from "../model";
import type { Saved, SaveInput } from "../namespace";
import { type Api, type AppContext, jsonError } from "./context";

/** A file-backed item before its bytes are in the blob store. */
type ObjectInput = DistributiveOmit<Extract<SaveInput, { object: string }>, "object" | "size">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const BURN_HEADER_VALUES = new Set(["1", "true", "yes"]);
/** Request types stored as text: what the page sends, and what `curl -d` sends. */
const TEXT_TYPES = new Set(["text/plain", "application/x-www-form-urlencoded"]);
const TEXT_MIME = "text/plain; charset=utf-8";

class InvalidUtf8Error extends Error {}

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
const burnRequested = (c: AppContext) =>
  BURN_HEADER_VALUES.has((c.req.header("burn") ?? "").trim().toLowerCase());

/**
 * A file upload, streamed to the blob store without holding it in memory.
 * The store needs the length up front and fails if the body does not match.
 */
type Upload = {
  body: ReadableStream;
  size: number;
  /** The first bytes, enough to recognize an image, read before uploading. */
  head: Uint8Array;
};

/** Reads the first `length` bytes and returns a stream that still yields everything. */
const peek = async (body: ReadableStream<Uint8Array>, length: number) => {
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
  const { head, body } = await peek(c.req.raw.body, IMAGE_SIGNATURE_BYTES);
  return { body, size, head };
};

/** Validates streamed UTF-8 while retaining just enough text for list previews. */
const validatedText = (upload: Upload) => {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
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

/** Reads a (small) request body, enforcing `limit` before and after reading. */
const readBody = async (c: AppContext, limit: number) => {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return jsonError(c, 413, `The limit is ${limit} bytes.`);
  }
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return jsonError(c, 400, "The content is empty.");
  if (bytes.byteLength > limit) return jsonError(c, 413, `The limit is ${limit} bytes.`);
  return bytes;
};

/** The type comes from the bytes themselves, never from what the client claims. */
const describePlainFile = (upload: Upload, filename: string | null): ObjectInput => {
  const detected = detectImage(upload.head);
  // A send without a name gets a default one, which never renames an item.
  const named = filename !== null;
  // Only recognized images are shown inline; everything else is a download.
  return detected
    ? {
        kind: "image",
        mime: detected.mime,
        filename: safeImageName(filename ?? "file", detected.extension),
        named,
      }
    : {
        kind: "file",
        mime: "application/octet-stream",
        filename: safeFileName(filename ?? "file"),
        named,
      };
};

/** A send's answer: 201 for a new item, 200 for contents already there, now on top. */
const sentResponse = (c: AppContext, ref: NamespaceRef, saved: Saved) =>
  saved.existing
    ? c.json({ ...publicItem(saved.item, ref), existing: true }, 200)
    : c.json(publicItem(saved.item, ref), 201);

export const createUploads = (api: Api) => {
  const { config, namespace, platformOf, later, record, visit } = api;

  /** Streams contents into the blob store, then records their key in the namespace. */
  const saveObject = async (
    c: AppContext,
    ref: NamespaceRef,
    upload: Upload,
    input: ObjectInput,
    validate?: () => void,
  ): Promise<Saved> => {
    // The file's own key, never shown: the item's ID is picked by the namespace.
    const object = `${ref.space}/${ref.name}/${crypto.randomUUID()}`;
    const contentType =
      input.kind === "sealed"
        ? "application/octet-stream"
        : input.kind === "text"
          ? TEXT_MIME
          : input.mime;
    const { blobs } = platformOf(c);
    // Plain files are hashed on the way to storage, so the same contents sent
    // again can be spotted; encrypted ones never match, so they are not.
    const hash = input.kind === "sealed" ? null : createHash("sha256");
    const body = hash
      ? upload.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              hash.update(chunk);
              controller.enqueue(chunk);
            },
          }),
        )
      : upload.body;
    await blobs.put(object, body, upload.size, contentType);
    try {
      validate?.();
      const saved = (await namespace(c, ref).save(
        ref,
        { ...input, object, size: upload.size, ...(hash ? { sha256: hash.digest("hex") } : {}) },
        burnRequested(c),
        visit(c),
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
    const upload = await streamedBody(c, config.maxFileBytes);
    if (upload instanceof Response) return upload;
    const saved = await saveObject(c, ref, upload, describePlainFile(upload, filename));
    record(c, "sentFile");
    return sentResponse(c, ref, saved);
  };

  const uploadPlain = async (c: AppContext, ref: NamespaceRef) => {
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
        const saved = await saveObject(c, ref, external.upload, external.input, external.validate);
        record(c, "sentText");
        return sentResponse(c, ref, saved);
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
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
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
      );
    } else {
      saved = (await namespace(c, ref).save(
        ref,
        {
          kind: "text",
          text,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
        },
        burnRequested(c),
        visit(c),
      )) as Saved;
    }
    record(c, "sentText");
    return sentResponse(c, ref, saved);
  };

  const uploadSealed = async (c: AppContext, ref: NamespaceRef) => {
    const metadata = c.req.header("x-sealed-metadata") ?? "";
    if (!SEALED_METADATA_PATTERN.test(metadata)) {
      return jsonError(c, 400, "Missing or invalid X-Sealed-Metadata header.");
    }
    // The browser checks that ciphertext (contents plus IV and tag) fits.
    const upload = await streamedBody(c, config.maxFileBytes);
    if (upload instanceof Response) return upload;
    const saved = await saveObject(c, ref, upload, { kind: "sealed", metadata });
    record(c, "sentEncrypted");
    return sentResponse(c, ref, saved);
  };

  return { uploadFile, uploadPlain, uploadSealed };
};
