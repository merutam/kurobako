// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import {
  contentSize,
  defaultTextName,
  fileMetadata,
  newViewId,
  openReadOnlySpace,
  openSealedSpace,
  textDownloadName,
} from "../../../../public/k.mjs";
import { request, SITE } from "../../lib/common.js";
import { describeOpened, describePlain, limitedItem } from "../../lib/items.js";
import { pushSkipHeaders } from "../../lib/push.js";
import { BUNDLE_MIME } from "../../shared/bundle.js";

const burnHeaders = (burn) => (burn ? { Burn: "1" } : {});
const sendHeaders = ({ burn, expiresIn }) => ({
  ...burnHeaders(burn),
  ...(expiresIn ? { "Expires-In": expiresIn } : {}),
  ...pushSkipHeaders(),
});
const versionOf = (item) => item.updatedAt ?? item.createdAt;

/*
 * A mode hides how items are stored. Loading a burn-after-reading item's
 * content deletes it on the server.
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
    pushKey: `plain:${namespace}`,
    title: `/${namespace}`,
    label: "",
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
        // So a picked .txt file never turns into a text item.
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
    editFile: async (item, file) =>
      (
        await request(`${basePath}/${encodeURIComponent(item.id)}/e`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Filename": encodeURIComponent(file.name),
            "If-Match": JSON.stringify(versionOf(item)),
            ...writeHeaders(),
          },
          body: file,
        })
      ).json(),
    rename,
  };
};

export const sealedMode = async ({ secretName, readToken }, writeHeaders) => {
  const space = readToken ? await openReadOnlySpace(readToken) : await openSealedSpace(secretName);
  const basePath = `${SITE}/e/${space.id}`;
  const readOnlyUrl = `${window.location.origin}${SITE}/e#/${space.readToken}`;
  /** Keyed on the header, which a rename changes. */
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

  const replace = async (item, replacement) =>
    (
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

  return {
    basePath,
    pushKey: `sealed:${space.id}`,
    title: readToken ? "Encrypted namespace" : `/e#${secretName}`,
    label: "Encrypted",
    // The limit counts the sealed body: a tag for every 64 KiB.
    fileLimit: (maxFileBytes) => contentSize(maxFileBytes),
    shareUrl: readToken
      ? readOnlyUrl
      : `${window.location.origin}${SITE}/e#${encodeURIComponent(secretName)}`,
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
    /** For the part of a share link the server never sees. */
    shareKey: async (item) => (await openItem(item))?.keyText ?? null,
    sendText: (text, settings) => {
      const bytes = new TextEncoder().encode(text);
      const title = settings.burn || settings.reads ? "" : (settings.name ?? defaultTextName(text));
      return send(bytes, { kind: "text", title, size: bytes.byteLength }, settings);
    },
    sendFile: async (file, settings) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The same rules as the server's: images by their bytes.
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
      return replace(item, await opened.withContents(bytes, { title: changedTitle }));
    },
    editFile: async (item, file) => {
      const opened = await openItem(item);
      if (!opened) throw new Error("This item could not be decrypted.");
      if (opened.metadata.mime !== BUNDLE_MIME) throw new Error("Only bundles take new files.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { filename } = fileMetadata(bytes, file.name);
      return replace(item, await opened.withContents(bytes, { title: filename, filename }));
    },
    /** Sealed again with the item's own key. */
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
