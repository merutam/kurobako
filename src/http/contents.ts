// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { ByteRange } from "../domain/host";
import { safeTextFileName } from "../domain/media";
import {
  type InlineTextItem,
  lastRead,
  type NamespaceRef,
  type ObjectItem,
  readLimitedItem,
  type StoredItem,
} from "../domain/model";
import type { ItemRef } from "../domain/namespace";
import type { Api, AppContext } from "./context";

/** RFC 6266: `filename*` for any name, plain `filename` for clients like `curl -J`. */
const attachment = (filename: string) => {
  const ascii = filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]|["\\]/g, "_");
  // RFC 5987 also wants ' ( ) * encoded, which encodeURIComponent leaves.
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

/** One range only (RFC 9110): several fall back to the whole object. */
const requestedRange = (
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (!first && !last) return null;
  if (!first) {
    const length = Math.min(Number(last), size);
    return length > 0 ? { offset: size - length, length } : "unsatisfiable";
  }
  const offset = Number(first);
  if (offset >= size) return "unsatisfiable";
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  return end < offset ? "unsatisfiable" : { offset, length: end - offset + 1 };
};

const contentTypeOf = (item: ObjectItem) =>
  item.kind === "sealed" ? "application/octet-stream" : item.mime;

const objectResponse = (
  item: ObjectItem,
  body: ReadableStream | ArrayBuffer,
  size: number,
  inline: boolean,
  unnamed: (id: string) => string,
  range: ByteRange | null = null,
) => {
  const disposition = inline
    ? "inline"
    : attachment(
        item.kind === "sealed"
          ? // Its name is sealed too: the server can only give it one of its own.
            `${unnamed(item.id)}.sealed`
          : item.kind === "text"
            ? item.name
              ? safeTextFileName(item.name)
              : `text-${unnamed(item.id)}.txt`
            : item.filename,
      );
  // Read whole and once: a range would consume it partway.
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": contentTypeOf(item),
      "Content-Length": String(range ? range.length : size),
      ...(range
        ? { "Content-Range": `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` }
        : {}),
      ...(readLimitedItem(item) ? {} : { "Accept-Ranges": "bytes" }),
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
};

export const createContents = (api: Api) => {
  const { namespace, platform, later, record, visit } = api;

  const noteRead = (c: AppContext, item: StoredItem) => {
    if (lastRead(item)) record(c, "openedOnce");
  };

  const serveObject = async (
    c: AppContext,
    ref: NamespaceRef,
    preview: ObjectItem,
    inline: boolean,
    unnamed: (id: string) => string,
  ): Promise<Response | null> => {
    const ns = namespace(ref);
    let item = preview;
    const { blobs } = platform;
    // Players ask for ranges to start and to seek.
    const range = readLimitedItem(item) ? null : requestedRange(c.req.header("range"), item.size);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${item.size}`, "Cache-Control": "no-store" },
      });
    }
    const object = await blobs.get(item.object, range ?? undefined);
    if (!object) {
      return null;
    }
    // Only a limited read must be claimed, atomically, once storage opened it.
    if (readLimitedItem(item)) {
      try {
        const claimed = await ns.claimObject(item.id, undefined, item.object);
        if (!claimed) {
          await object.body.cancel();
          return null;
        }
        item = claimed;
      } catch (error) {
        await object.body.cancel().catch(() => {});
        throw error;
      }
    }
    noteRead(c, item);
    if (lastRead(item)) {
      // Deleted once streamed, or once the client gives up: the read happened either way.
      const { readable, writable } = new TransformStream();
      later(
        c,
        object.body
          .pipeTo(writable)
          .catch(() => {})
          .finally(() => blobs.delete([item.object])),
      );
      return objectResponse(item, readable, object.size, inline, unnamed);
    }
    return objectResponse(item, object.body, object.size, inline, unnamed, range);
  };

  /** Named downloads, so `curl -OJ` saves them sensibly. */
  const serveItem = async (
    c: AppContext,
    ref: NamespaceRef,
    selector: ItemRef,
    inline: boolean,
    unnamed: (id: string) => string = (id) => id,
  ): Promise<Response | null> => {
    // One call: an object then opens from storage, a text is already here.
    const opened = (await namespace(ref).openItem(selector, visit(c))) as
      | { text: InlineTextItem }
      | { object: ObjectItem }
      | null;
    if (!opened) return null;
    if ("object" in opened) return serveObject(c, ref, opened.object, inline, unnamed);
    const { text } = opened;
    noteRead(c, text);
    return c.body(text.text, 200, {
      "Content-Type": text.mime,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...(inline
        ? {}
        : {
            "Content-Disposition": attachment(
              text.name ? safeTextFileName(text.name) : `text-${unnamed(text.id)}.txt`,
            ),
          }),
    });
  };

  return { serveItem };
};
