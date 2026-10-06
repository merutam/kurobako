// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Serving an item's contents, for namespace routes and share links alike.
import { safeFileName } from "../image";
import type { NamespaceRef, ObjectItem, StoredItem } from "../model";
import type { ItemRef } from "../namespace";
import type { ByteRange } from "../platform";
import type { Api, AppContext } from "./context";

/**
 * Both forms of the file name (RFC 6266): `filename*` keeps any character,
 * and the plain `filename` (ASCII only) is for clients that ignore the
 * other one, such as `curl -J`.
 */
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

/**
 * The bytes a Range header asks for (RFC 9110): one range, "bytes=a-b",
 * "bytes=a-" or "bytes=-n". Null serves the whole object (no header, or
 * several ranges); "unsatisfiable" is a range outside it.
 */
export const requestedRange = (
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
              ? safeFileName(`${item.name}.txt`)
              : `text-${unnamed(item.id)}.txt`
            : item.filename,
      );
  // A burn-after-reading item is read whole, once: it takes no ranges.
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": contentTypeOf(item),
      "Content-Length": String(range ? range.length : size),
      ...(range
        ? { "Content-Range": `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` }
        : {}),
      ...(item.burn ? {} : { "Accept-Ranges": "bytes" }),
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
};

export const createContents = (api: Api) => {
  const { namespace, platformOf, later, record, visit } = api;

  const noteRead = (c: AppContext, item: StoredItem) => {
    if (item.burn) record(c, "openedOnce");
  };

  /**
   * Serves a file-backed item straight from the blob store. The namespace
   * only hands out (and, for burn-after-reading, removes) the item.
   */
  const serveObject = async (
    c: AppContext,
    ref: NamespaceRef,
    selector: ItemRef,
    inline: boolean,
    unnamed: (id: string) => string,
  ): Promise<Response | null> => {
    const ns = namespace(c, ref);
    const item = (await ns.claimObject(selector, visit(c))) as ObjectItem | null;
    if (!item) return null;
    const { blobs } = platformOf(c);
    // Players ask for parts of a video (to start and to seek): any item but
    // a burn-after-reading one may be read in parts.
    const range = item.burn ? null : requestedRange(c.req.header("range"), item.size);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${item.size}`, "Cache-Control": "no-store" },
      });
    }
    const object = await blobs.get(item.object, range ?? undefined);
    if (!object) {
      if (!item.burn) await ns.remove(item.id);
      return null;
    }
    noteRead(c, item);
    if (item.burn) {
      // The only read: once the file has been streamed out, or the client
      // gave up halfway, delete it.
      const { readable, writable } = new TransformStream();
      later(
        c,
        object.body
          .pipeTo(writable)
          .catch(() => {
            // The client went away; the item is consumed all the same.
          })
          .finally(() => blobs.delete([item.object])),
      );
      return objectResponse(item, readable, object.size, inline, unnamed);
    }
    return objectResponse(item, object.body, object.size, inline, unnamed, range);
  };

  /**
   * Any item's contents: texts as text, files from the blob store. As a
   * download, an item goes by its name, so `curl -OJ` saves it sensibly; one
   * without (a text never named, an encrypted item) by `unnamed(id)`:
   * text-<it>.txt or <it>.sealed.
   */
  const serveItem = async (
    c: AppContext,
    ref: NamespaceRef,
    selector: ItemRef,
    inline: boolean,
    unnamed: (id: string) => string = (id) => id,
  ): Promise<Response | null> => {
    const text = await namespace(c, ref).readText(selector, visit(c));
    if (text) {
      noteRead(c, text);
      return c.body(text.text, 200, {
        "Content-Type": text.mime,
        "Cache-Control": "no-store",
        ...(inline
          ? {}
          : {
              "Content-Disposition": attachment(
                text.name ? safeFileName(`${text.name}.txt`) : `text-${unnamed(text.id)}.txt`,
              ),
            }),
      });
    }
    return serveObject(c, ref, selector, inline, unnamed);
  };

  return { serveItem };
};
