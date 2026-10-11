// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { FileField } from "./components/file-field";
import { Icon } from "./components/icons";
import { ItemsSection, type ListedItem, namespaceRows } from "./components/items";
import { Page, type SiteView } from "./components/layout";
import { MediaFeed } from "./components/media-feed";

/**
 * A namespace's page. A plain one (`name`) comes with its queue: rendered,
 * and as data (`queue-data`) for the page's script, with the revision the
 * live updates continue from. An encrypted one is opened in the browser.
 */
export const renderNamespacePage = (
  site: SiteView,
  name: string | null,
  queue: { items: ReadonlyArray<ListedItem & { id: string }>; revision: number },
  maxItems: number,
) => {
  const { items } = queue;
  const plain = name !== null;
  const path = plain ? `${site.basePath}/${name}` : "";
  return Page({
    site,
    title: plain ? `/${name} · Kurobako` : "Kurobako",
    scripts: ["read-link", "namespace"],
    config: true,
    data: plain ? { id: "queue-data", value: queue } : undefined,
    unlocking: !plain,
    children: (
      <>
        {!plain ? (
          <div id="page-loading" class="page-loading" role="status" aria-live="polite">
            <span class="loading-spinner" aria-hidden="true" />
            <span>Unlocking namespace…</span>
          </div>
        ) : null}
        <h1 id="page-title">{plain ? `/${name}` : "Namespace"}</h1>
        <p class="intro">
          <span id="mode-label" />
          <span id="expiry-label" />
          <span id="page-links">
            {plain ? (
              <>
                {" · "}
                <a data-icon="users" href={`${path}/log`}>
                  <Icon name="users" />
                  Access log
                </a>
                {" · "}
                <a data-icon="json" href={`${path}/ls`}>
                  <Icon name="json" />
                  See JSON
                </a>
              </>
            ) : null}
          </span>
        </p>
        <p id="status" class="status" role="status" aria-live="polite" />
        <MediaFeed />
        <section id="access-options" class="namespace-settings" aria-labelledby="settings-title">
          <h2 id="settings-title">Settings</h2>
          <div class="settings-grid">
            <div id="burn-option" class="setting-row">
              <label class="checkbox-label setting-check">
                <input id="burn" type="checkbox" disabled />
                <span data-icon="burn">
                  <Icon name="burn" />
                  Delete after first open
                </span>
              </label>
            </div>
            <div class="setting-row expiry-setting">
              <label for="expires-in">Expires after</label>
              <select id="expires-in" />
            </div>
          </div>
        </section>
        <section id="send-section" class="stack" aria-labelledby="send-title">
          <h2 id="send-title">Send</h2>
          <form id="text-form">
            <fieldset>
              <textarea
                id="text"
                name="text"
                rows={8}
                aria-label="Text"
                aria-describedby="text-limit"
                required
              />
              <div class="editor-toolbar">
                <select id="text-language" aria-label="Syntax highlighting">
                  <option value="">Plain text</option>
                </select>
                <p id="text-limit" class="hint" />
              </div>
              <div id="text-name-row" class="text-name-row">
                <label for="text-name">File name</label>
                <div class="text-name-control">
                  <input
                    id="text-name"
                    type="text"
                    value="text"
                    maxlength={100}
                    autocomplete="off"
                    spellcheck={false}
                    aria-describedby="text-extension"
                  />
                  <span id="text-extension">.txt</span>
                </div>
              </div>
              <div class="form-footer">
                <button data-icon="send" type="submit" class="primary">
                  <Icon name="send" />
                  Send
                </button>
              </div>
            </fieldset>
          </form>
          <form id="file-form">
            <fieldset>
              <legend id="file-legend">File</legend>
              <FileField
                id="file"
                name="file"
                multiple
                labelledBy="file-legend"
                describedBy="file-limit"
              />
              <p id="file-limit" class="hint" />
              <p class="actions">
                <button data-icon="send" type="submit" class="primary">
                  <Icon name="send" />
                  Send
                </button>
              </p>
            </fieldset>
          </form>
        </section>
        <ItemsSection
          rows={plain ? namespaceRows(path, items) : null}
          size={items.length}
          count={plain ? `${items.length}/${maxItems}` : ""}
          live
          known={plain}
        />
        <section class="page-section stack" aria-labelledby="qr-title">
          <h2 id="qr-title">Open on another device</h2>
          <img
            id="qr"
            class="qr-code"
            width="160"
            height="160"
            alt="QR code linking to this page"
          />
          <div class="copy-link">
            <input id="page-url" type="text" readOnly aria-label="Link to this page" />
            <button data-icon="copy" id="copy-link" type="button">
              <Icon name="copy" />
              Copy link
            </button>
          </div>
          <p>
            <button id="create-view" data-icon="share" type="button" hidden>
              <Icon name="share" />
              Create shared view
            </button>
          </p>
          <div id="view-link-row" class="copy-link" hidden>
            <input id="view-link" type="text" readOnly aria-label="Shared view link" />
            <button id="copy-view-link" data-icon="copy" type="button">
              <Icon name="copy" />
              Copy link
            </button>
          </div>
        </section>
        <section class="page-section stack" aria-labelledby="backup-title">
          <h2 id="backup-title">Backup</h2>
          <p id="backup-hint" class="hint">
            Every item as a zip or a tar. Items that delete when opened are left out.
          </p>
          <p class="actions">
            <button data-icon="download" id="backup-zip" type="button">
              <Icon name="download" />
              Download zip
            </button>
            <button data-icon="download" id="backup-tar" type="button">
              <Icon name="download" />
              Download tar
            </button>
          </p>
          <form id="restore-form">
            <fieldset>
              <legend id="restore-legend">Restore</legend>
              <FileField
                id="restore-file"
                accept=".zip,.tar,application/zip,application/x-tar"
                labelledBy="restore-legend"
                describedBy="restore-hint"
              />
              <p id="restore-hint" class="hint">
                A backup of a namespace (zip or tar); items already here are skipped.
              </p>
              <p class="actions">
                <button data-icon="upload" type="submit" class="primary">
                  <Icon name="upload" />
                  Restore
                </button>
              </p>
            </fieldset>
          </form>
        </section>
      </>
    ),
  });
};
