// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { Choices } from "./choices";

/** The browser fills this feed near the viewport; both page types share it. */
export const MediaFeed = () => (
  <section id="media-feed" class="media-feed" aria-labelledby="media-feed-title" hidden>
    <p>
      <a id="media-feed-back" href=".">
        Back to items
      </a>
    </p>
    <div class="media-feed-heading">
      <h1 id="media-feed-title">Media</h1>
      <span class="media-feed-options">
        <Choices
          id="media-view"
          label="view"
          name="Media view"
          choices={[
            ["list", "list"],
            ["grid", "grid"],
            ["details", "details"],
          ]}
          current="list"
        />
        <Choices
          id="media-filter"
          label="show"
          name="Filter media"
          choices={[
            ["all", "all"],
            ["images", "images"],
            ["videos", "videos"],
            ["audios", "audio"],
          ]}
          current="all"
        />
      </span>
    </div>
    <div id="media-feed-list" class="media-feed-list" />
  </section>
);
