// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { HtmlEscapedString } from "hono/utils/html";
import { Icon } from "./icons";

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
