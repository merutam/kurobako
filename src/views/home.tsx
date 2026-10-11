// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { AppConfig } from "../config";
import { Icon } from "./icons";
import { Page, type SiteView } from "./layout";

const number = new Intl.NumberFormat("en-US");

const bytes = (size: number) => {
  if (size < 1000) return `${size} B`;
  const units = ["kB", "MB", "GB"];
  let value = size / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${Number(value.toFixed(value < 10 ? 1 : 0))} ${units[unit]}`;
};

const duration = (seconds: number) => {
  if (!seconds) return "Never";
  const units = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ] as const;
  const [unit, size] = units.find(([, size]) => seconds >= size) ?? ["second", 1];
  const value = Math.round(seconds / size);
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
};

/** The home page has no per-request state: the server renders it once, at start. */
export const renderHomePage = (site: SiteView, config: AppConfig) => {
  const limits = [
    ["max-items", "Items per namespace", number.format(config.maxItems)],
    ["expiry", "Items expire after", duration(config.itemTtlMs / 1000)],
    ["max-file-size", "Maximum file size", bytes(config.maxFileBytes)],
    ["max-text-size", "Maximum text size", bytes(config.maxTextBytes)],
    ["sends-per-minute", "Sends per client per minute", number.format(config.sendsPerMinute)],
  ] as const;
  return Page({
    site,
    title: "Kurobako",
    scripts: ["home.js"],
    config: true,
    children: (
      <>
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
                  name="namespace"
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
                    name="encrypted"
                    type="checkbox"
                    aria-label="Enable end-to-end encryption"
                    aria-describedby="namespace-hint"
                    checked
                  />
                  <button
                    id="e2ee-help"
                    type="button"
                    aria-haspopup="dialog"
                    aria-controls="e2ee-dialog"
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
                <button data-icon="random" id="random-name" type="button">
                  <Icon name="random" />
                  Random name
                </button>
                <button data-icon="open" type="submit" class="primary">
                  <Icon name="open" />
                  Open
                </button>
              </p>
              <p id="home-status" class="status" role="status" aria-live="polite" />
            </fieldset>
          </form>
        </section>
        <dialog id="e2ee-dialog" class="e2ee-dialog" aria-labelledby="e2ee-title">
          <h2 id="e2ee-title">End-to-end encryption</h2>
          <p>
            Your browser encrypts items before sending them. The server stores ciphertext and cannot
            read their contents.
          </p>
          <p>
            The secret name after <code>#</code> stays in the browser. Anyone with the full link can
            read the items; without that name, they cannot be recovered.
          </p>
          <form method="dialog" class="e2ee-dialog-actions">
            <button type="submit">Close</button>
          </form>
        </dialog>

        <section id="stats-section" class="stack page-section" aria-labelledby="about-title">
          <h2 id="about-title">Stats</h2>
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
          <p>
            <a data-icon="json" href={`${site.basePath}/stats.json`}>
              <Icon name="json" />
              Full statistics
            </a>
          </p>
        </section>
      </>
    ),
  });
};
