// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What arriving bytes are, before anything keeps them. The type always comes
// from the bytes, never from what the client claims.
import { createHash } from "node:crypto";
import { BUNDLE_MIME, isBundle } from "../client/shared/bundle.js";
import { detectMedia, safeFileName, safeMediaName } from "./media";
import { type NamespaceRef, TEXT_PREVIEW_CHARS } from "./model";
import type { SaveInput } from "./namespace";

export type ObjectInput = DistributiveOmit<
  Extract<SaveInput, { object: string }>,
  "object" | "size"
>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const TEXT_MIME = "text/plain; charset=utf-8";

export class InvalidUtf8Error extends Error {}

/** A new one each time: the decoder keeps state between chunks. */
export const strictUtf8 = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Random, so a key is never reused or guessed from the item. */
export const objectKey = (ref: NamespaceRef) => `${ref.space}/${ref.name}/${crypto.randomUUID()}`;

/** Kept to spot the same contents sent again. */
export const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Hashed on the way through, so large files are never held in memory. */
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

/** Blob stores need the length up front and fail when the body does not match it. */
export type Upload = {
  body: ReadableStream;
  size: number;
  /** Enough to recognize the type before uploading. */
  head: Uint8Array;
};

/** The returned stream still yields the peeked bytes. */
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

/** Only a preview is kept, so a large text is never held in memory. */
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
            // The store expects the full length; the blob is deleted before any item points at it.
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

export const describePlainFile = (upload: Upload, filename: string | null): ObjectInput => {
  const detected = detectMedia(upload.head);
  // A default name never renames an item when it is sent again.
  const named = filename !== null;
  // Video and audio keep their type so pages can play them; anything unknown is a download.
  if (detected) {
    return {
      kind: detected.kind === "image" ? "image" : "file",
      mime: detected.mime,
      filename: safeMediaName(filename ?? "file", detected.extension, detected.kind),
      named,
    };
  }
  // Bundles keep their type so pages can show what they hold.
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
