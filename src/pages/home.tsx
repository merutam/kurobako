// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { formatBytes, formatDuration } from "../client/shared/format.js";
import type { AppConfig } from "../config";
import { Layout, type SiteView } from "./components/layout";

const number = new Intl.NumberFormat("en-US");

const lifetime = (seconds: number) => (seconds ? formatDuration(seconds) : "Never");

/** No per-request state, so the server renders it once. */
export const HomePage = ({ site, config }: { site: SiteView; config: AppConfig }) => {
  const limits = [
    ["max-items", "Items per namespace", number.format(config.maxItems)],
    ["expiry", "Items expire after", lifetime(config.itemTtlMs / 1000)],
    ["max-file-size", "Maximum file size", formatBytes(config.maxFileBytes)],
    ["max-text-size", "Maximum text size", formatBytes(config.maxTextBytes)],
    ["sends-per-minute", "Sends per client per minute", number.format(config.sendsPerMinute)],
  ] as const;
  return (
    <Layout site={site} title="Kurobako" scripts={["home"]} config>
      <h1 id="page-title">/e#</h1>
      <p class="intro">Share text and files between devices.</p>

      <section class="stack" aria-labelledby="namespace-title">
        <h2 id="namespace-title">Namespace</h2>
        <form id="namespace-form">
          <fieldset>
            <div id="namespace-field" class="namespace-input">
              <span id="namespace-prefix" class="namespace-prefix" aria-hidden="true">
                /e#
              </span>
              <input
                id="namespace"
                type="text"
                placeholder="a long secret name"
                maxlength={256}
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                aria-label="Namespace name"
                aria-describedby="namespace-hint name-strength home-status"
                required
              />
              <div class="e2ee-control">
                <input
                  id="encrypted"
                  type="checkbox"
                  aria-label="Enable end-to-end encryption"
                  aria-describedby="namespace-hint"
                  checked
                />
                <button
                  id="e2ee-help"
                  type="button"
                  aria-haspopup="dialog"
                  command="show-modal"
                  commandfor="e2ee-dialog"
                  title="End-to-end encryption: items are encrypted before they reach the server."
                >
                  E2EE
                </button>
              </div>
            </div>
            <p id="namespace-hint" class="hint">
              E2EE. Max 256 characters.
            </p>
            <p id="name-strength" class="hint" aria-live="polite" hidden />
            <p class="actions">
              <button id="random-name" type="button">
                Random name
              </button>
              {/* Enabled by the script: sent natively, a secret name would land in the URL. */}
              <button type="submit" class="primary" disabled>
                Open
              </button>
            </p>
            <p id="home-status" class="status" role="status" aria-live="polite" />
          </fieldset>
        </form>
      </section>
      <dialog id="e2ee-dialog" class="dialog" aria-labelledby="e2ee-title">
        <h2 id="e2ee-title">End-to-end encryption</h2>
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

      <section id="stats-section" class="stack page-section" aria-labelledby="about-title">
        <h2 id="about-title">Stats</h2>
        <div class="table-scroll">
          <table class="data-table">
            <tbody>
              {limits.map(([id, label, value]) => (
                <tr>
                  <th scope="row">{label}</th>
                  <td id={id}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <a href={`${site.basePath}/stats.json`}>Full statistics</a>
        </p>
      </section>
    </Layout>
  );
};
