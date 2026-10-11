// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import {
  backupHint,
  expiryOptions,
  fileLimitText,
  maxFilesAtOnce,
  sealedFileLimit,
  textSizeText,
} from "../client/shared/limits.js";
import type { AppConfig } from "../config";
import { FileField } from "./components/file-field";
import { firstMediaId, ItemsSection, type ListedItem, namespaceRows } from "./components/items";
import { Page, type SiteView } from "./components/layout";
import { MediaFeed } from "./components/media-feed";

/**
 * A namespace's page. A plain one (`name`) comes with its queue: rendered,
 * and as data (`queue-data`) for the page's script, with the revision the
 * live updates continue from. An encrypted one is opened in the browser.
 * The instance's limits are written here, so the page's script only checks
 * against them.
 */
export const renderNamespacePage = (
  site: SiteView,
  name: string | null,
  queue: { items: ReadonlyArray<ListedItem & { id: string }>; revision: number },
  config: Pick<
    AppConfig,
    "maxItems" | "itemTtlMs" | "maxFileBytes" | "maxTextBytes" | "sendsPerMinute"
  >,
) => {
  const { items } = queue;
  const { maxItems, maxTextBytes } = config;
  const plain = name !== null;
  const ttlSeconds = config.itemTtlMs / 1000;
  const fileLimit = plain ? config.maxFileBytes : sealedFileLimit(config.maxFileBytes);
  const path = plain ? `${site.basePath}/${name}` : "";
  return Page({
    site,
    title: plain ? `/${name} · Kurobako` : "Kurobako",
    scripts: ["namespace"],
    config: true,
    data: plain ? { id: "queue-data", value: queue } : undefined,
    decrypting: plain ? undefined : "Decrypting namespace…",
    children: (
      <>
        <h1 id="page-title">{plain ? `/${name}` : "Namespace"}</h1>
        {/* What the namespace is (an encrypted one says so) and its links; the
            styles put the " · " between the parts there are. Expiry is each
            item's, so it shows on the items, not here. */}
        <p class="intro namespace-intro">
          <span id="mode-label" />
          <span id="page-links">
            {plain ? (
              <>
                <a href={`${path}/log`}>Access log</a>
                {" · "}
                <a href={`${path}/ls`}>As JSON</a>
              </>
            ) : null}
          </span>
          {/* Off until asked, per device (lib/push.js); shown when the server sends any. */}
          <button id="notify-toggle" type="button" class="row-action" aria-pressed="false" hidden>
            notify: off
          </button>
        </p>
        <p id="status" class="status" role="status" aria-live="polite" />
        <MediaFeed />
        <section id="send-section" class="stack" aria-labelledby="send-title">
          <div class="section-heading">
            <h2 id="send-title">Send</h2>
            {/* How sends go: closed, it says what differs from the defaults (forms.js). */}
            <details id="send-settings" class="send-settings">
              <summary>
                settings
                <span id="settings-state" />
              </summary>
              <div class="settings-popup">
                <label class="checkbox-label setting-check">
                  <input id="burn" type="checkbox" /> Delete after first open
                </label>
                <div class="expiry-setting">
                  <label for="expires-in">Expires after</label>
                  <select id="expires-in">
                    {expiryOptions(ttlSeconds).map(([label, value]) => (
                      <option value={value}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </details>
          </div>
          {/* One composer: text tabs and files, sent as a text, as files, or
              together as one bundle (forms.js decides, by what it holds). */}
          {/* No native validation: a send may be texts, files or both (forms.js). */}
          <form id="send-form" novalidate>
            <fieldset>
              <div class="tabs composer-tabs" role="tablist" aria-label="What to send">
                <span id="text-tabs" class="text-tabs">
                  <button
                    type="button"
                    role="tab"
                    aria-selected="true"
                    aria-controls="text-panel"
                    data-tab="0"
                    title="Click again, double-click or press F2 to rename"
                  >
                    text.md
                  </button>
                </span>
                <button
                  id="add-tab"
                  type="button"
                  class="tab-add"
                  aria-label="New text tab"
                  title="New text tab"
                >
                  +
                </button>
                <button
                  id="files-tab"
                  type="button"
                  role="tab"
                  aria-selected="false"
                  aria-controls="files-panel"
                >
                  files
                </button>
              </div>
              <div id="text-panel" role="tabpanel">
                <textarea
                  id="text"
                  name="text"
                  rows={8}
                  aria-label="Text"
                  maxlength={maxTextBytes}
                  aria-describedby="text-limit"
                />
                <div id="markdown-preview" class="markdown-preview" hidden />
                <div class="editor-toolbar">
                  {/* Markdown by default; forms.js adds every language. */}
                  <select id="text-language" aria-label="Syntax highlighting">
                    <option value="">Plain text</option>
                    <option value="md" selected>
                      Markdown · .md
                    </option>
                  </select>
                  <button id="preview-toggle" type="button" class="row-action" aria-pressed="false">
                    preview
                  </button>
                  <p id="text-limit" class="hint">
                    {textSizeText(0, maxTextBytes)}
                  </p>
                </div>
              </div>
              <div id="files-panel" role="tabpanel" hidden>
                <FileField
                  id="file"
                  name="file"
                  multiple
                  labelledBy="files-tab"
                  describedBy="file-limit"
                />
                {/* What is picked, one per line with its size (forms.js). */}
                <ul id="file-list" class="file-list" aria-label="Files to send" hidden />
                <p id="file-limit" class="hint">
                  {fileLimitText(maxFilesAtOnce(config), fileLimit)}
                </p>
              </div>
              <div class="form-footer">
                <p id="send-summary" class="hint" aria-live="polite" />
                {/* Editing an item, Send saves it instead (forms.js). */}
                <button id="cancel-edit" type="button" hidden>
                  Cancel
                </button>
                <button id="send-button" type="submit" class="primary">
                  Send
                </button>
              </div>
            </fieldset>
          </form>
        </section>
        <ItemsSection
          rows={plain ? namespaceRows(path, items) : null}
          size={items.length}
          count={plain ? `${items.length}/${maxItems}` : ""}
          mediaId={plain ? firstMediaId(items.map((item) => ({ id: item.id, item }))) : undefined}
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
            <button id="copy-link" type="button">
              Copy link
            </button>
          </div>
          <p>
            {/* A plain address writes; an encrypted page knows only once opened. */}
            <button id="create-view" type="button" hidden={!plain}>
              Create shared view
            </button>
          </p>
          <div id="view-link-row" class="copy-link" hidden>
            <input id="view-link" type="text" readOnly aria-label="Shared view link" />
            <button id="copy-view-link" type="button">
              Copy link
            </button>
          </div>
        </section>
        <section class="page-section stack" aria-labelledby="backup-title">
          <h2 id="backup-title">Backup</h2>
          <p id="backup-hint" class="hint">
            {backupHint(!plain)}
          </p>
          <p class="actions">
            <button id="backup-zip" type="button">
              Save zip
            </button>
            <button id="backup-tar" type="button">
              Save tar
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
                <button type="submit" class="primary">
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
