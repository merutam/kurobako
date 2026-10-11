// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Lists of items, as the namespace and shared-view pages show them: the
// section, and its rows made as the browser makes them.

import { raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { formatBytes } from "../../client/shared/format.js";
import { describePlain, itemRow, rowHash, rowState } from "../../client/shared/item-row.js";
import { h } from "./html";
import { Icon } from "./icons";

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

/** What an item goes by: its name, a text's start, or "file". */
export const titleOf = (item: ListedItem) => describePlain(item).title ?? "file";

type Row = { item: ListedItem & { id: string }; info: object; downloadUrl: string | null };

/**
 * Rows as the browser makes them (src/client/shared/item-row.js), each with the hash of
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

/** The items' section: `rows` from namespaceRows or viewRows, `size` how many. */
export const ItemsSection = ({
  rows,
  size,
  count,
  live = false,
  known = true,
}: {
  rows: HtmlEscapedString | null;
  size: number;
  count: string;
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
        <a class="media-link" data-icon="image" id="open-media" href="?media" hidden>
          <Icon name="image" />
          Media
        </a>
        <select id="expand-mode" aria-label="Show contents">
          <option value="one">One at a time</option>
          <option value="several">Several at once</option>
          <option value="all">All</option>
        </select>
        <button
          class="icon-button"
          data-icon="refresh"
          id="refresh"
          type="button"
          aria-label="Refresh items"
          title="Refresh items"
        >
          <Icon name="refresh" />
        </button>
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
