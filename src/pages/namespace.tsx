// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import {
  backupHint,
  expiryLabel,
  expiryOptions,
  fileLimitText,
  maxFilesAtOnce,
  sealedFileLimit,
  textSizeText,
} from "../client/shared/limits.js";
import type { AppConfig } from "../config";
import { FileField } from "./components/file-field";
import { Icon } from "./components/icons";
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
    scripts: ["read-link", "namespace"],
    config: true,
    data: plain ? { id: "queue-data", value: queue } : undefined,
    decrypting: plain ? undefined : "Decrypting namespace…",
    children: (
      <>
        <h1 id="page-title">{plain ? `/${name}` : "Namespace"}</h1>
        <p class="intro">
          <span id="mode-label" />
          <span id="expiry-label">{expiryLabel(ttlSeconds)}</span>
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
                <input id="burn" type="checkbox" />
                <span data-icon="burn">
                  <Icon name="burn" />
                  Delete after first open
                </span>
              </label>
            </div>
            <div class="setting-row expiry-setting">
              <label for="expires-in">Expires after</label>
              <select id="expires-in">
                {expiryOptions(ttlSeconds).map(([label, value]) => (
                  <option value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>
        </section>
        <section id="send-section" class="stack" aria-labelledby="send-title">
          <h2 id="send-title">Send</h2>
          <form id="text-form">
            <fieldset>
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
              <textarea
                id="text"
                name="text"
                rows={8}
                aria-label="Text"
                maxlength={maxTextBytes}
                aria-describedby="text-limit"
                required
              />
              <div class="editor-toolbar">
                <select id="text-language" aria-label="Syntax highlighting">
                  <option value="">Plain text</option>
                </select>
                <p id="text-limit" class="hint">
                  {textSizeText(0, maxTextBytes)}
                </p>
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
              {/* What is picked, one per line with its size (forms.js). */}
              <ul id="file-list" class="file-list" aria-label="Files to send" hidden />
              <p id="file-limit" class="hint">
                {fileLimitText(maxFilesAtOnce(config), fileLimit)}
              </p>
              <p class="actions">
                {/* Phones offer no Paste in a text box when the clipboard holds
                    only an image: this reads it (forms.js), where browsers can. */}
                <button id="paste-files" type="button">
                  Paste from clipboard
                </button>
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
            <button data-icon="copy" id="copy-link" type="button">
              <Icon name="copy" />
              Copy link
            </button>
          </div>
          <p>
            {/* A plain address writes; an encrypted page knows only once opened. */}
            <button id="create-view" data-icon="share" type="button" hidden={!plain}>
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
            {backupHint(!plain)}
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
