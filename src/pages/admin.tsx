// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { FileField } from "./components/file-field";
import { Icon } from "./components/icons";
import { Page, type SiteView } from "./components/layout";

/**
 * The admin dashboard, /k/a. With a session, the dashboard comes out open with
 * its first answers embedded (`admin-data`), so admin.js draws them at once;
 * without one, only the login shows: a plain form, which the server answers
 * with this page again, logged in or with `error`.
 */
export const renderAdminPage = (
  site: SiteView,
  data: { overview: unknown; namespaces: unknown } | null,
  error = "",
) =>
  Page({
    site,
    title: "Admin · Kurobako",
    // Logged out, the page is only its form.
    scripts: data ? ["admin"] : [],
    data: data ? { id: "admin-data", value: data } : undefined,
    noIndex: true,
    children: (
      <>
        <h1>/k/a</h1>
        <p class="intro" id="summary">
          Admin
        </p>

        <p id="status" class={error ? "status error" : "status"} role="status" aria-live="polite">
          {error}
        </p>

        <form
          id="login-form"
          class="login-form"
          method="post"
          action={`${site.basePath}/k/a/login`}
          hidden={data ? true : undefined}
        >
          <fieldset>
            <legend>Log in</legend>
            <label for="key">Admin key</label>
            <input id="key" name="key" type="password" autocomplete="current-password" required />
            <p class="actions">
              <button data-icon="login" type="submit" class="primary">
                <Icon name="login" />
                Log in
              </button>
            </p>
          </fieldset>
        </form>

        <form id="logout-form" method="post" action={`${site.basePath}/k/a/logout`} />
        <div id="dashboard" hidden={data ? undefined : true}>
          <p class="toolbar">
            <label for="server" hidden>
              Server
            </label>
            <select id="server" hidden />
            <label for="refresh-interval">Auto-refresh</label>
            <select id="refresh-interval">
              <option value="0">Off</option>
              <option value="5" selected>
                5 s
              </option>
              <option value="30">30 s</option>
            </select>
            <button data-icon="refresh" id="refresh" type="button">
              <Icon name="refresh" />
              Refresh
            </button>
            <button data-icon="logout" id="logout" type="submit" form="logout-form">
              <Icon name="logout" />
              Log out
            </button>
          </p>

          <div class="columns">
            <section class="stack" aria-labelledby="system-title">
              <h2 id="system-title">System</h2>
              <table class="data-table stats-table">
                <tbody id="system-stats" />
              </table>
            </section>

            <section id="logs" class="stack" aria-labelledby="logs-title" hidden>
              <h2 id="logs-title">Requests, errors and logs</h2>
              <p id="logs-link" />
            </section>
          </div>

          <section class="stack" aria-labelledby="backup-title">
            <h2 id="backup-title">Backup</h2>
            <p class="hint">
              Every namespace as a zip or a tar. Items that delete when opened are left out. A
              backup larger than a request may be split in parts: see the README.
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
                  A backup of the instance or of a namespace (zip or tar).
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

          <section class="stack" aria-labelledby="namespaces-title">
            <h2 id="namespaces-title">Namespaces</h2>
            <p class="toolbar">
              <input id="namespace-search" type="search" aria-label="Filter namespaces" />
            </p>
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Namespace</th>
                    <th>Items</th>
                    <th>Links</th>
                  </tr>
                </thead>
                <tbody id="namespaces" />
              </table>
            </div>
            <p id="namespaces-pagination" class="pagination" />
          </section>
        </div>
      </>
    ),
  });
