// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { formatBytes } from "../../client/shared/format.js";
import {
  describePlain,
  itemRow,
  limitedItem,
  rowHash,
  rowState,
} from "../../client/shared/item-row.js";
import { Choices } from "./choices";
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

export const titleOf = (item: ListedItem) => describePlain(item).title ?? "file";

type Row = { item: ListedItem & { id: string }; info: object; downloadUrl: string | null };

/** Hashed, so the browser keeps the server's rows instead of rebuilding them. */
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

/** A plain address writes, so its rows get write actions. */
export const namespaceRows = (path: string, items: ReadonlyArray<ListedItem & { id: string }>) =>
  itemRows(
    items.map((item) => ({
      item,
      info: describePlain(item),
      downloadUrl: `${path}/${item.id}/d`,
    })),
    true,
  );

/** Its items carry no IDs; the browser names them by their link's token, and so does this. */
export const viewRows = (entries: ReadonlyArray<{ url: string; item: ListedItem }>) =>
  itemRows(
    entries.map(({ url, item }) => ({
      item: { ...item, id: url.split("/").pop() ?? "" },
      info: { ...describePlain(item), itemUrl: url },
      downloadUrl: `${url}/d`,
    })),
    false,
  );

/** The media feed's link opens at this item. */
export const firstMediaId = (entries: ReadonlyArray<{ id: string; item: ListedItem }>) =>
  entries.find(({ item }) => {
    const info = describePlain(item);
    return (info.isImage || info.isVideo || info.isAudio) && !limitedItem(item);
  })?.id;

export const ItemsSection = ({
  rows,
  size,
  count,
  mediaId,
  live = false,
  known = true,
}: {
  rows: HtmlEscapedString | null;
  size: number;
  count: string;
  mediaId?: string;
  live?: boolean;
  known?: boolean;
}) => (
  <section id="items-section" class="page-section stack" aria-labelledby="queue-title">
    <div class="section-heading">
      <h2 id="queue-title">
        Items <small id="item-count">{count}</small>{" "}
        {live ? (
          <>
            <small id="live-status" class="live-status" />{" "}
            <small id="viewers" title="Pages open on this namespace right now, this one included" />
          </>
        ) : null}
      </h2>
      <span class="actions">
        <a
          class="row-action"
          id="open-media"
          href={mediaId ? `?media=${mediaId}` : "?media"}
          hidden={!mediaId}
        >
          media
        </a>
        <Choices
          id="expand-mode"
          label="open"
          name="Open items"
          choices={[
            ["one", "one"],
            ["several", "several"],
            ["all", "all"],
          ]}
          current="one"
        />
      </span>
    </div>
    <ol id="items" class="items">
      {rows}
    </ol>
    <p id="empty" class="empty" hidden={!known || size > 0}>
      No items.
    </p>
  </section>
);
