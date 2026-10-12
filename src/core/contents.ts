// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// An item's contents as they arrive, before anything keeps them: what kind
// of item the bytes make (the type comes from the bytes, never from what the
// client claims), whether a text is UTF-8, and their SHA-256, worked out as
// they stream through.
import { createHash } from "node:crypto";
import { BUNDLE_MIME, isBundle } from "../client/shared/bundle.js";
import { detectMedia, safeFileName, safeMediaName } from "./media";
import { type NamespaceRef, TEXT_PREVIEW_CHARS } from "./model";
import type { SaveInput } from "./namespace";

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
