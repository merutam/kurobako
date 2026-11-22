// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A shared item, as a shared view's list with one row: the same rows and
// actions as a namespace, read-only. Encrypted items carry their own key
// after the #, so the link leads to nothing else.
import { openSharedItem } from "../../../sdk/k.mjs";
import { createItemList } from "../features/namespace/item-list.js";
import { element, request } from "../lib/common.js";
import { describeOpened, describePlain, sealedStream } from "../lib/items.js";
import { createStatus } from "../lib/status.js";
import { failUnlocking, finishUnlocking } from "../lib/unlocking.js";

const status = createStatus(element("#status"));
const keyText = decodeURIComponent(window.location.hash.slice(1));
const here = window.location.pathname.replace(/\/$/, "");
// The row is named by its link's token, as on the server, never by the item's ID.
const token = here.split("/").pop();

/** Decrypted once: describing, loading and streaming all need it. */
let opened = null;
const openItem = async (item) => {
  if (!keyText) throw new Error("Incomplete link: the part after # is missing.");
  opened ??= await openSharedItem(keyText, item.metadata, item.size);
  return opened;
};

const describe = async (item) =>
  item.kind === "sealed" ? describeOpened((await openItem(item)).metadata) : describePlain(item);

/** For an item with limited reads this is a read. */
const contentBytes = async (item) => {
  const bytes = new Uint8Array(
    await (await request(`${here}/c`, { cache: "no-store" })).arrayBuffer(),
  );
  return item.kind === "sealed" ? (await openItem(item)).open(bytes) : bytes;
};

const mode = {
  basePath: "",
  describe,
  loadText: async (item) =>
    item.kind === "text" && item.text !== undefined
      ? item.text
      : new TextDecoder().decode(await contentBytes(item)),
  loadBlob: async (item) =>
    new Blob([await contentBytes(item)], {
      type: (await describe(item)).mime || "application/octet-stream",
    }),
  mediaUrl: () => `${here}/c`,
  downloadUrl: (item) => (item.kind === "sealed" ? null : `${here}/d`),
  streamOf: async (item) =>
    sealedStream({
      url: `${window.location.origin}${here}/c`,
      key: await (await openItem(item)).bodyKey(),
      item,
      details: await describe(item),
    }),
};

const itemList = createItemList({
  status,
  access: { canWrite: () => false, writeHeaders: () => ({}) },
  // A shared item has nothing to refresh: it is there or gone.
  refreshUnlessLive: async () => {},
  startOpen: true,
  numbered: false,
});
itemList.setMode(mode);

// null once gone, which the page already says.
const data = JSON.parse(element("#item-data").textContent);
if (data) {
  try {
    const item = { ...data, id: token };
    // Only the key in the fragment tells what an encrypted item is.
    if (item.kind === "sealed") document.title = `${(await describe(item)).title} · Kurobako`;
    await itemList.renderItems([item]);
    setInterval(itemList.updateExpiries, 30_000);
    finishUnlocking();
  } catch (error) {
    if (document.querySelector("#page-loading")) failUnlocking(error.message);
    else status.error(error.message);
  }
}
