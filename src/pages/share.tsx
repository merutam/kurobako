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
            <input
              id="share-target"
              type="text"
              placeholder="notes, e#secret name, or a link"
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              aria-describedby="share-hint"
            />
            <p id="share-hint" class="hint">
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
      </>
    ),
  });
