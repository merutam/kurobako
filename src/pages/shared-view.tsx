// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { Icon } from "./components/icons";
import { ItemsSection, type ListedItem, viewRows } from "./components/items";
import { Page, type SiteView } from "./components/layout";
import { MediaFeed } from "./components/media-feed";

type ViewPageData = {
  entries: ReadonlyArray<{ url: string; item: ListedItem }>;
};

export const renderSharedViewPage = (site: SiteView, view: ViewPageData) => {
  const sealed = view.entries.some(({ item }) => item.kind === "sealed");
  return Page({
    site,
    title: "Shared view · Kurobako",
    scripts: ["shared-view"],
    config: true,
    data: { id: "view-data", value: view },
    noIndex: true,
    children: (
      <>
        <h1>Shared view</h1>
        <p class="intro">
          Read-only. New items appear here while this view is active; existing items stay live after
          it freezes.
        </p>
        <p id="view-status" class="status" role="status" aria-live="polite">
          {sealed ? "Decrypting shared view…" : null}
        </p>
        <MediaFeed />
        <ItemsSection
          rows={sealed ? null : viewRows(view.entries)}
          size={sealed ? 0 : view.entries.length}
          count={sealed ? "" : String(view.entries.length)}
          known={!sealed}
        />
        <section class="page-section" aria-labelledby="clone-title">
          <h2 id="clone-title">Clone into a new namespace</h2>
          <p class="hint">
            Copies the items available now. The copy will not follow future changes; interrupted
            copies may be partial.
          </p>
          <form id="clone-form" class="stack">
            <label for="clone-name">New namespace</label>
            <div id="clone-field" class="namespace-input">
              <span class="namespace-prefix" aria-hidden="true">
                /
              </span>
              <input
                id="clone-name"
                type="text"
                placeholder="myns"
                maxlength={64}
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                aria-describedby="clone-hint view-status"
                required
              />
              <div class="e2ee-control">
                <input
                  id="clone-encrypted"
                  type="checkbox"
                  aria-label="Enable end-to-end encryption"
                  aria-describedby="clone-hint"
                />
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-controls="clone-e2ee-dialog"
                  title="End-to-end encryption: items are encrypted before they reach the server."
                >
                  E2EE
                </button>
              </div>
            </div>
            <p id="clone-hint" class="hint">
              a-z, 0-9, _ and -. Max 64 characters.
            </p>
            <label class="checkbox-label">
              <input id="clone-limited" type="checkbox" /> Include read-limited items (each copy
              consumes one read)
            </label>
            <p class="actions">
              <button type="submit" data-icon="copy">
                <Icon name="copy" />
                Clone
              </button>
            </p>
          </form>
          <dialog id="clone-e2ee-dialog" class="e2ee-dialog" aria-labelledby="clone-e2ee-title">
            <h2 id="clone-e2ee-title">End-to-end encryption</h2>
            <p>
              Your browser encrypts items before sending them. The server stores ciphertext and
              cannot read their contents.
            </p>
            <p>
              The secret name after <code>#</code> stays in the browser. Anyone with the full link
              can read the items; without that name, they cannot be recovered.
            </p>
            <form method="dialog" class="e2ee-dialog-actions">
              <button type="submit">Close</button>
            </form>
          </dialog>
        </section>
      </>
    ),
  });
};
