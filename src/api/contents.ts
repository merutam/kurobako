// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Serving an item's contents, for namespace routes and share links alike.
import { safeFileName } from "../image";
import type { NamespaceRef, ObjectItem, StoredItem } from "../model";
import type { ItemRef } from "../namespace";
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

const contentTypeOf = (item: ObjectItem) =>
  item.kind === "sealed" ? "application/octet-stream" : item.mime;

const objectResponse = (
  item: ObjectItem,
  body: ReadableStream | ArrayBuffer,
  size: number,
  inline: boolean,
) => {
  const disposition = inline
    ? "inline"
    : item.kind === "sealed"
      ? "attachment"
      : attachment(item.filename);
  return new Response(body, {
    headers: {
      "Content-Type": contentTypeOf(item),
      "Content-Length": String(size),
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
  ): Promise<Response | null> => {
    const ns = namespace(c, ref);
    const item = (await ns.claimObject(selector, visit(c))) as ObjectItem | null;
    if (!item) return null;
    const { blobs } = platformOf(c);
    const object = await blobs.get(item.object);
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
      return objectResponse(item, readable, object.size, inline);
    }
    return objectResponse(item, object.body, object.size, inline);
  };

  /**
   * Any item's contents: texts as text, files from the blob store. As a
   * download, a text goes by its name, or by `fallbackName(id)` without one,
   * so `curl -OJ` saves it under a sensible name.
   */
  const serveItem = async (
    c: AppContext,
    ref: NamespaceRef,
    selector: ItemRef,
    inline: boolean,
    fallbackName: (id: string) => string = (id) => `text-${id}.txt`,
  ): Promise<Response | null> => {
    const text = (await namespace(c, ref).readText(selector, visit(c))) as StoredItem | null;
    if (text?.kind === "text") {
      noteRead(c, text);
      return c.body(text.text, 200, {
        "Content-Type": text.mime,
        "Cache-Control": "no-store",
        ...(inline
          ? {}
          : {
              "Content-Disposition": attachment(
                text.name ? safeFileName(`${text.name}.txt`) : fallbackName(text.id),
              ),
            }),
      });
    }
    return serveObject(c, ref, selector, inline);
  };

  return { serveItem };
};
