// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { raw } from "hono/html";
import { formatBytes } from "../../public/format.js";
import { describePlain, itemRow, rowHash, rowState } from "../../public/item-row.js";
import { h } from "./html";

export { formatBytes };

export type ListedItem = {
  kind: "text" | "image" | "file" | "sealed";
  createdAt: string;
  size: number;
  name?: string;
  filename?: string;
  mime?: string;
  text?: string;
  preview?: string;
  burn?: boolean;
  readsLeft?: number;
};

export const titleOf = (item: ListedItem) => {
  if (item.kind !== "text") return item.filename ?? "file";
  if (item.name) return item.name;
  if (item.burn || item.readsLeft !== undefined) return "Hidden until opened";
  return (item.text ?? item.preview ?? "").replace(/\s+/gu, " ").trim() || "(blank)";
};

type Row = { item: ListedItem & { id: string }; info: object; downloadUrl: string | null };

/**
 * Rows as the browser makes them (public/item-row.js), each with the hash of
 * what it was made from, so the browser keeps them instead of making them again.
 */
const itemRows = (rows: readonly Row[], canWrite: boolean) =>
  raw(
    rows
      .map(({ item, info, downloadUrl }, index) =>
        itemRow(h, {
          item,
          info,
          position: index + 1,
          canWrite,
          // Unknown here: a browser that cannot drops the button.
          canCopyImages: true,
          downloadUrl,
          made: rowHash(rowState(item, info, false, canWrite)),
        }),
      )
      .join(""),
  );

/** A plain namespace's rows, at `path` (/<name>): its address writes. */
export const namespaceRows = (path: string, items: ReadonlyArray<ListedItem & { id: string }>) =>
  itemRows(
    items.map((item) => ({
      item,
      info: describePlain(item),
      downloadUrl: `${path}/${item.id}/d`,
    })),
    true,
  );

/**
 * A plain shared view's rows. Its items carry no IDs; the browser names them
 * by their link's token (see view.js), and so does this.
 */
export const viewRows = (entries: ReadonlyArray<{ url: string; item: ListedItem }>) =>
  itemRows(
    entries.map(({ url, item }) => ({
      item: { ...item, id: url.split("/").pop() ?? "" },
      info: { ...describePlain(item), itemUrl: url },
      downloadUrl: `${url}/d`,
    })),
    false,
  );
