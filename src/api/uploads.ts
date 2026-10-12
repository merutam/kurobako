// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import {
  describePlainFile,
  InvalidUtf8Error,
  peek,
  sha256Of,
  strictUtf8,
  type Upload,
  validatedText,
} from "../core/contents";
// Receiving items: a send's or an edit's headers and body, and the answer.
// Keeping the contents is services/items.ts.
import { SIGNATURE_BYTES, safeFileName } from "../core/media";
import {
  type NamespaceRef,
  publicItem,
  SEALED_METADATA_PATTERN,
  TEXT_PREVIEW_CHARS,
} from "../core/model";
import type { ItemRef, Saved } from "../core/namespace";
import {
  createItems,
  type EditOptions,
  type ReplaceResult,
  type SendOptions,
} from "../services/items";
import { type Api, type AppContext, jsonError, readLimited, writeVerifier } from "./context";

const BURN_HEADER_VALUES = new Set(["1", "true", "yes"]);
const MAX_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;
const MAX_READS = 1_000_000;
/** Request types stored as text: what the page sends, and what `curl -d` sends. */
const TEXT_TYPES = new Set(["text/plain", "application/x-www-form-urlencoded"]);
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

/** Reads a (small) request body, stopping at `limit`. */
const readBody = async (c: AppContext, limit: number) => {
  const bytes = await readLimited(c, limit);
  if (!bytes) return jsonError(c, 413, `The limit is ${limit} bytes.`);
  if (bytes.byteLength === 0) return jsonError(c, 400, "The content is empty.");
  return bytes;
};

/** A send's answer: 201 for a new item, 200 for contents already there, now on top. */
const sentResponse = (c: AppContext, saved: Saved) =>
  saved.existing
    ? c.json({ ...publicItem(saved.item), existing: true }, 200)
    : c.json(publicItem(saved.item), 201);

export const createUploads = (api: Api) => {
  const { config, later, record, visit } = api;
  const items = createItems(api);
  const defer = (c: AppContext) => (work: Promise<unknown>) => later(c, work);

  /** The send's options, from its headers (see SendOptions). */
  const sendOptions = async (
    c: AppContext,
    expiresInSeconds: number | null,
    reads: number | null,
  ): Promise<SendOptions> => {
    const token = c.req.header("view-token");
    const envelope = c.req.header("view-envelope");
    const skip = c.req.header("push-skip")?.trim() ?? "";
    return {
      burn: burnRequested(c),
      visitor: visit(c),
      expiresInSeconds,
      reads,
      verifier: await writeVerifier(c),
      view: token ? { token, ...(envelope ? { envelope } : {}) } : undefined,
      deduplicate: c.req.header("no-dedup") !== "1",
      // The sending device's push subscription (see core/push.ts).
      pushSkip: /^[A-Za-z0-9_-]{22}$/.test(skip) ? skip : null,
    };
  };
  const editOptions = async (c: AppContext): Promise<EditOptions> => ({
    visitor: visit(c),
    verifier: await writeVerifier(c),
  });

  const uploadFile = async (c: AppContext, ref: NamespaceRef, filename: string | null) => {
    const expiresIn = requestedExpiry(c, config.itemTtlMs);
    if (expiresIn instanceof Response) return expiresIn;
    const reads = requestedReads(c);
    if (reads instanceof Response) return reads;
    const upload = await streamedBody(c, config.maxFileBytes);
    if (upload instanceof Response) return upload;
    const saved = await items.saveObject(
      ref,
      upload,
      describePlainFile(upload, filename),
      await sendOptions(c, expiresIn, reads),
      defer(c),
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
    const requestedName = decodeFilename(c.req.header("x-text-name"));
    const name =
      requestedName === null ? undefined : safeFileName(requestedName.replace(/[\\/]/g, "-"));
    if (name && (burnRequested(c) || reads !== null)) {
      return jsonError(c, 400, "A limited-read text cannot have a public name.");
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
        const saved = await items.saveObject(
          ref,
          external.upload,
          { ...external.input, ...(name ? { name } : {}) },
          await sendOptions(c, expiresIn, reads),
          defer(c),
          external.validate,
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
      saved = await items.saveObject(
        ref,
        { body: new Blob([bytes]).stream(), size: bytes.byteLength, head: new Uint8Array() },
        { kind: "text", preview: text.slice(0, TEXT_PREVIEW_CHARS), ...(name ? { name } : {}) },
        await sendOptions(c, expiresIn, reads),
        defer(c),
      );
    } else {
      saved = await items.save(
        ref,
        {
          kind: "text",
          text,
          size: bytes.byteLength,
          sha256: sha256Of(bytes),
          ...(name ? { name } : {}),
        },
        await sendOptions(c, expiresIn, reads),
      );
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
    const saved = await items.saveObject(
      ref,
      upload,
      { kind: "sealed", metadata },
      await sendOptions(c, expiresIn, reads),
      defer(c),
    );
    record(c, "sentEncrypted");
    return sentResponse(c, saved);
  };

  const editResponse = (c: AppContext, result: ReplaceResult) => {
    if (!result) return jsonError(c, 404, "Item not found.");
    if ("error" in result) return jsonError(c, result.conflict ? 412 : 400, result.error);
    const kind = result.item.kind;
    record(c, kind === "sealed" ? "sentEncrypted" : kind === "text" ? "sentText" : "sentFile");
    return c.json(publicItem(result.item));
  };

  /**
   * Replaces one text, using the same inline/blob and UTF-8 rules as a send,
   * or one bundle, sent as a file is (Content-Type: application/octet-stream).
   */
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
        await items.replaceObject(
          ref,
          item,
          expected,
          upload,
          { kind: "sealed", metadata },
          await editOptions(c),
          defer(c),
        ),
      );
    }

    const contentType = (c.req.header("content-type") || "").split(";", 1)[0]?.trim().toLowerCase();
    if (!TEXT_TYPES.has(contentType ?? "")) {
      // Only a bundle becomes another bundle (see replacedItem).
      const upload = await streamedBody(c, config.maxFileBytes);
      if (upload instanceof Response) return upload;
      const input = describePlainFile(upload, decodeFilename(c.req.header("x-filename")));
      return editResponse(
        c,
        await items.replaceObject(
          ref,
          item,
          expected,
          upload,
          input,
          await editOptions(c),
          defer(c),
        ),
      );
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
          await items.replaceObject(
            ref,
            item,
            expected,
            external.upload,
            external.input,
            await editOptions(c),
            defer(c),
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
        ? await items.replaceObject(
            ref,
            item,
            expected,
            { body: new Blob([bytes]).stream(), size: bytes.byteLength, head: new Uint8Array() },
            { kind: "text", preview: text.slice(0, TEXT_PREVIEW_CHARS) },
            await editOptions(c),
            defer(c),
          )
        : await items.replace(
            ref,
            item,
            expected,
            { kind: "text", text, size: bytes.byteLength, sha256: sha256Of(bytes) },
            await editOptions(c),
          );
    return editResponse(c, result);
  };

  return { editText, uploadFile, uploadPlain, uploadSealed };
};
