// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { request, SITE } from "../common.js";
import { describeOpened, describePlain, limitedItem } from "../items.js";
import {
  contentSize,
  defaultTextName,
  fileMetadata,
  newViewId,
  openReadOnlySpace,
  openSealedSpace,
  textDownloadName,
} from "../k.mjs";

const burnHeaders = (burn) => (burn ? { Burn: "1" } : {});
const sendHeaders = ({ burn, expiresIn }) => ({
  ...burnHeaders(burn),
  ...(expiresIn ? { "Expires-In": expiresIn } : {}),
});
const versionOf = (item) => item.updatedAt ?? item.createdAt;

/*
 * A mode hides how items are stored. Every item is described as
 *   { kind: "text" | "file", title, size, filename?, mime?, isImage }
 * and its content is loaded on demand as text or a Blob. Loading the content
 * of a burn-after-reading item deletes it on the server.
 */
export const plainMode = (namespace, writeHeaders) => {
  const basePath = `${SITE}/${encodeURIComponent(namespace)}`;
  const rename = (item, name) =>
    request(`${basePath}/${encodeURIComponent(item.id)}/n`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8", ...writeHeaders() },
      body: name,
    });
  return {
    basePath,
    title: `/${namespace}`,
    label: "",
    /** The largest file a send takes, in bytes of its own contents. */
    fileLimit: (maxFileBytes) => maxFileBytes,
    shareUrl: `${window.location.origin}${basePath}`,
    createView: async () => {
      const { items, views } = await (await request(`${basePath}/views`)).json();
      const created = await (
        await request(`${basePath}/views`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            viewId: newViewId(),
            previousToken: views.find((view) => view.active)?.token ?? null,
            entries: items.map((item) => ({ id: item.id })),
          }),
        })
      ).json();
      return `${window.location.origin}${created.url}`;
    },
    describe: async (item) => describePlain(item),
    loadText: async (item) =>
      item.text ?? (await request(`${basePath}/${item.id}`, { cache: "no-store" })).text(),
    loadBlob: async (item) =>
      (await request(`${basePath}/${item.id}`, { cache: "no-store" })).blob(),
    downloadUrl: (item) => `${basePath}/${item.id}/d`,
    /** Plain share links need nothing besides the token. */
    shareKey: async () => null,
    sendText: (text, settings) =>
      request(`${basePath}/new`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...(!settings.burn && settings.name
            ? { "X-Text-Name": encodeURIComponent(settings.name) }
            : {}),
          ...sendHeaders(settings),
          ...writeHeaders(),
        },
        body: text,
      }),
    sendFile: (file, settings) =>
      request(`${basePath}/new`, {
        method: "POST",
        // The server detects images from the bytes; never let a picked .txt
        // file turn into a text item.
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
          ...sendHeaders(settings),
          ...writeHeaders(),
        },
        body: file,
      }),
    editText: async (item, text, { title }) => {
      const response = await request(`${basePath}/${encodeURIComponent(item.id)}/e`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "If-Match": JSON.stringify(versionOf(item)),
          ...writeHeaders(),
        },
        body: text,
      });
      const edited = await response.json();
      return title === null ? edited : (await rename(edited, title)).json();
    },
    /** An empty name gives a text back its default, the start of its text. */
    rename,
  };
};

/** An encrypted namespace, by its secret name or a read-only link's token. */
export const sealedMode = async ({ secretName, readToken }, writeHeaders) => {
  const space = readToken ? await openReadOnlySpace(readToken) : await openSealedSpace(secretName);
  const basePath = `${SITE}/e/${space.id}`;
  const readOnlyUrl = `${window.location.origin}${SITE}/e#/${space.readToken}`;
  /**
   * Metadata header → its unwrapped key and metadata (a promise; null if
   * unreadable). Keyed on the header, which a rename changes.
   */
  const openedItems = new Map();
  const openItem = (item) => {
    if (!openedItems.has(item.metadata)) {
      openedItems.set(
        item.metadata,
        space.openItem(item.metadata, item.size).catch(() => null),
      );
    }
    return openedItems.get(item.metadata);
  };
  const loadBytes = async (item) => {
    const opened = await openItem(item);
    if (!opened) throw new Error("This item could not be decrypted.");
    const response = await request(`${basePath}/${item.id}`, { cache: "no-store" });
    return opened.open(await response.arrayBuffer());
  };
  const send = async (bytes, metadata, settings) => {
    const viewStatus = await (
      await request(`${basePath}/views`, { headers: writeHeaders() })
    ).json();
    const active = viewStatus.views.find((view) => view.active);
    const { header, body, keyText } = await space.sealItem(bytes, metadata);
    return request(`${basePath}/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Sealed-Metadata": header,
        ...(active
          ? {
              "View-Token": active.token,
              "View-Envelope": await space.sealViewEntry(active.viewId, keyText),
            }
          : {}),
        ...sendHeaders(settings),
        ...writeHeaders(),
      },
      body,
    });
  };

  return {
    basePath,
    title: readToken ? "Encrypted namespace" : `/e#${secretName}`,
    label: "Encrypted",
    // The limit counts the sealed body: a tag for every 64 KiB.
    fileLimit: (maxFileBytes) => contentSize(maxFileBytes),
    // Opened by a read-only link, that link is what it passes on.
    shareUrl: readToken
      ? readOnlyUrl
      : `${window.location.origin}${SITE}/e#${encodeURIComponent(secretName)}`,
    /** The name-derived write key; none by a read-only link. */
    writeKey: space.writeKey,
    readOnlyUrl,
    createView: async () => {
      const { items, views } = await (
        await request(`${basePath}/views`, { headers: writeHeaders() })
      ).json();
      const viewId = newViewId();
      const entries = await Promise.all(
        items.map(async (item) => {
          const opened = await openItem(item);
          if (!opened) throw new Error("An item could not be decrypted for this view.");
          return { id: item.id, envelope: await space.sealViewEntry(viewId, opened.keyText) };
        }),
      );
      const created = await (
        await request(`${basePath}/views`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...writeHeaders() },
          body: JSON.stringify({
            viewId,
            previousToken: views.find((view) => view.active)?.token ?? null,
            entries,
          }),
        })
      ).json();
      return `${window.location.origin}${created.url}#${await space.viewKey(viewId)}`;
    },
    describe: async (item) => {
      const opened = await openItem(item);
      if (!opened) return { kind: "unreadable", title: "(could not decrypt)", size: item.size };
      return describeOpened(opened.metadata);
    },
    loadText: async (item) => new TextDecoder().decode(await loadBytes(item)),
    loadBlob: async (item) => {
      const { metadata } = await openItem(item);
      return new Blob([await loadBytes(item)], {
        type: metadata.mime || "application/octet-stream",
      });
    },
    downloadUrl: null,
    /** What the Service Worker needs to read the item in parts (see streamAddress). */
    streamOf: async (item) => {
      const opened = await openItem(item);
      if (!opened) throw new Error("This item could not be decrypted.");
      return {
        url: `${window.location.origin}${basePath}/${encodeURIComponent(item.id)}`,
        key: await opened.bodyKey(),
        sealedSize: item.size,
        size: opened.metadata.size,
        mime: opened.metadata.mime || "application/octet-stream",
        filename:
          opened.metadata.kind === "text"
            ? textDownloadName(opened.metadata.title, item.id)
            : opened.metadata.filename || "file",
      };
    },
    /** The item's own key, for the part of a share link the server never sees. */
    shareKey: async (item) => (await openItem(item))?.keyText ?? null,
    sendText: (text, settings) => {
      const bytes = new TextEncoder().encode(text);
      const title = settings.burn || settings.reads ? "" : (settings.name ?? defaultTextName(text));
      return send(bytes, { kind: "text", title, size: bytes.byteLength }, settings);
    },
    sendFile: async (file, settings) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The same rules as the server's for plain files: images by their bytes.
      return send(bytes, fileMetadata(bytes, file.name), settings);
    },
    editText: async (item, text, { original, title }) => {
      const opened = await openItem(item);
      if (!opened) throw new Error("This item could not be decrypted.");
      if (opened.metadata.kind !== "text") throw new Error("Only texts can be edited.");
      const bytes = new TextEncoder().encode(text);
      const changedTitle =
        title ??
        (opened.metadata.title === defaultTextName(original)
          ? defaultTextName(text)
          : opened.metadata.title);
      const replacement = await opened.withContents(bytes, { title: changedTitle });
      return (
        await request(`${basePath}/${encodeURIComponent(item.id)}/e`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "If-Match": JSON.stringify(versionOf(item)),
            "X-Sealed-Metadata": replacement.header,
            ...writeHeaders(),
          },
          body: replacement.body,
        })
      ).json();
    },
    /**
     * The new name goes into the item's metadata, sealed again with its own
     * key. An empty name gives a text back its default, the start of its text.
     */
    rename: async (item, name) => {
      const opened = await openItem(item);
      if (!opened) throw new Error("This item could not be decrypted.");
      const isText = opened.metadata.kind === "text";
      let changes = { title: name, ...(isText ? {} : { filename: name }) };
      if (isText && !name) {
        changes = {
          title: limitedItem(item)
            ? ""
            : defaultTextName(new TextDecoder().decode(await loadBytes(item))),
        };
      } else if (!name) {
        throw new Error("A file needs a name.");
      }
      return request(`${basePath}/${encodeURIComponent(item.id)}/n`, {
        method: "POST",
        headers: {
          "X-Sealed-Metadata": await opened.withMetadata(changes),
          "If-Match": JSON.stringify(versionOf(item)),
          ...writeHeaders(),
        },
      });
    },
  };
};
