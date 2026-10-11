// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { Icon } from "./icons";

/** The browser fills this feed near the viewport; both page types share it. */
export const MediaFeed = () => (
  <section id="media-feed" class="media-feed" aria-labelledby="media-feed-title" hidden>
    <p>
      <a id="media-feed-back" href=".">
        ← Back to items
      </a>
    </p>
    <div class="media-feed-heading">
      <h1 id="media-feed-title">Media</h1>
      <fieldset class="media-view-options">
        <legend class="visually-hidden">Media view</legend>
        <button data-icon="image" data-media-view="list" type="button" aria-pressed="true">
          <Icon name="image" />
          List
        </button>
        <button data-icon="grid" data-media-view="grid" type="button" aria-pressed="false">
          <Icon name="grid" />
          Grid
        </button>
        <button data-icon="list" data-media-view="details" type="button" aria-pressed="false">
          <Icon name="list" />
          Details
        </button>
      </fieldset>
      <select id="media-filter" aria-label="Filter media">
        <option value="all">All media</option>
        <option value="images">Images</option>
        <option value="videos">Videos</option>
        <option value="audios">Audio</option>
      </select>
    </div>
    <div id="media-feed-list" class="media-feed-list" />
  </section>
);
