// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Where Android's Share menu leads, once the site is installed as an app:
// what was shared waits on the device (public/sw.js) while this page asks
// which namespace it goes to, then opens that one with it in the composer.
import { Page, type SiteView } from "./components/layout";

export const renderSharePage = (site: SiteView) =>
  Page({
    site,
    title: "Share · Kurobako",
    scripts: ["share"],
    config: true,
    noIndex: true,
    children: (
      <>
        <h1 id="page-title">Share</h1>
        <p class="intro">Pick a namespace: it opens with this in its composer, ready to send.</p>
        <p id="status" class="status" role="status" aria-live="polite" />

        <section id="shared" class="stack" aria-labelledby="shared-title" hidden>
          <h2 id="shared-title">Shared</h2>
          <pre id="shared-text" class="shared-text" hidden />
          <ul id="shared-files" class="file-list" aria-label="Shared files" hidden />
        </section>

        <form
          id="share-form"
          class="stack page-section"
          aria-labelledby="share-to-title"
          novalidate
          hidden
        >
          <h2 id="share-to-title">Send to</h2>
          <fieldset>
            <ul id="recent" class="file-list recent-list" aria-label="Recent namespaces" hidden />
            <label id="share-target-label" for="share-target">
              Namespace
            </label>
            <div id="share-field" class="namespace-input">
              <span id="share-prefix" class="namespace-prefix" aria-hidden="true">
                /e#
              </span>
              <input
                id="share-target"
                type="text"
                placeholder="a long secret name"
                maxlength={256}
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                aria-describedby="share-hint status"
                required
              />
              <div class="e2ee-control">
                <input
                  id="share-encrypted"
                  type="checkbox"
                  aria-label="Enable end-to-end encryption"
                  aria-describedby="share-hint"
                  checked
                />
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-controls="share-e2ee-dialog"
                  title="End-to-end encryption: items are encrypted before they reach the server."
                >
                  E2EE
                </button>
              </div>
            </div>
            <p id="share-hint" class="hint">
              E2EE. Max 256 characters.
            </p>
            <p class="hint">
              The namespaces you send to are remembered on this device; × forgets one.
            </p>
            <div class="form-footer">
              <button id="discard" type="button">
                Discard
              </button>
              <button type="submit" class="primary">
                Open
              </button>
            </div>
          </fieldset>
        </form>
        <dialog id="share-e2ee-dialog" class="dialog" aria-labelledby="share-e2ee-title">
          <h2 id="share-e2ee-title">End-to-end encryption</h2>
          <p>
            Your browser encrypts items before sending them. The server stores ciphertext and cannot
            read their contents.
          </p>
          <p>
            The secret name after <code>#</code> stays in the browser. Anyone with the full link can
            read the items; without that name, they cannot be recovered.
          </p>
          <form method="dialog" class="dialog-actions">
            <button type="submit">Close</button>
          </form>
        </dialog>
      </>
    ),
  });
