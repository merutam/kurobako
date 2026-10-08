// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { createHash } from "node:crypto";
import packageJson from "../package.json";
import type { AppConfig } from "./config";
import { type AccessLogEntry, locationOf } from "./request-info";

export type WebAssets = {
  /** App version shown in the page footer. */
  version: string;
  /** The frame every page is put in; see composePage. */
  layout: string;
  /** A namespace's page, /<name> or /e#<name>. */
  namespaceHtml: string;
  homeHtml: string;
  adminHtml: string;
  /** The page for one shared item, /i/<token>. */
  itemHtml: string;
  viewHtml: string;
  /** The protocol, plain and encrypted, /k/protocol. */
  protocolHtml: string;
  /** The project and dependency licenses, /k/licenses. */
  licensesHtml: string;
  /** A private instance's login, /k/login. */
  loginHtml: string;
  /** Static files served from the site root, keyed by path. */
  files: Record<string, string>;
};

const PAGES = {
  namespaceHtml: "namespace.html",
  homeHtml: "home.html",
  adminHtml: "admin.html",
  itemHtml: "item.html",
  viewHtml: "view.html",
  protocolHtml: "protocol.html",
  licensesHtml: "licenses.html",
  loginHtml: "login.html",
} as const;

/** Files in public/ that pages load, served as they are at /<path>. */
export const STATIC_FILES = [
  "namespaces/index.js",
  "namespaces/modes.js",
  "namespaces/item-list.js",
  "namespaces/live.js",
  "namespaces/forms.js",
  "namespaces/access.js",
  "home.js",
  "item.js",
  "view.js",
  "common.js",
  "components.js",
  "items.js",
  "icons.js",
  "access.js",
  "media-feed.js",
  "text-editor.js",
  "sw.js",
  "admin.js",
  "login.js",
  "log.js",
  "loading.js",
  "k.mjs",
  "status.js",
  "theme.js",
  "scroll-top.js",
  "styles.css",
  "tokens.css",
  "vendor/highlight.js",
  "vendor/uqr.js",
];

/** Binary files served as they are at /<path>: the icons browsers and iOS ask for. */
export const ICON_FILES = ["favicon.ico", "apple-touch-icon.png", "logo.png"];

/** Whether a path inside the site (/common.js) is one of the files above. */
export const isPublicFile = (path: string) =>
  STATIC_FILES.includes(path.slice(1)) || ICON_FILES.includes(path.slice(1));

const LAYOUT = "layout.html";

/**
 * A whole page: the layout with a page's own <head> tags and its <main>
 * (attributes included) put in. A page in public/ is just those two parts.
 */
export const composePage = (layout: string, page: string): string => {
  // Comments before the <head> (such as the license notice) stay out.
  const parts =
    /^\s*(?:<!--[\s\S]*?-->\s*)*<head>([\s\S]*?)<\/head>\s*<main([^>]*)>([\s\S]*)<\/main>\s*$/.exec(
      page,
    );
  if (!parts) throw new Error("A page must be a <head> followed by a <main>.");
  const [, head = "", attributes = "", main = ""] = parts;
  // Functions, so "$&" and the like in a page stay literal.
  return layout
    .replace("<!--%HEAD%-->", () => head.trim())
    .replace("%MAIN_ATTRIBUTES%", () => attributes)
    .replace("<!--%MAIN%-->", () => main.trim());
};

/** Reads the pages and static files with `read(path)`, a path inside public/. */
export const loadAssets = async (read: (path: string) => Promise<string>): Promise<WebAssets> => {
  const readAll = async (paths: readonly string[]) =>
    Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await read(path)])));
  const [pages, files, layout] = await Promise.all([
    readAll(Object.values(PAGES)),
    readAll(STATIC_FILES),
    read(LAYOUT),
  ]);
  // Put together once, at start: each request gets a finished string.
  const page = (key: keyof typeof PAGES) => composePage(layout, pages[PAGES[key]] ?? "");
  return {
    version: packageJson.version,
    layout,
    namespaceHtml: page("namespaceHtml"),
    homeHtml: page("homeHtml"),
    adminHtml: page("adminHtml"),
    itemHtml: page("itemHtml"),
    viewHtml: page("viewHtml"),
    protocolHtml: page("protocolHtml"),
    licensesHtml: page("licensesHtml"),
    loginHtml: page("loginHtml"),
    files,
  };
};

/**
 * The static files' content hash. It goes on the pages' script and style
 * URLs, so a new deployment never pairs a fresh page with a stale file still
 * in some cache.
 */
export const staticFiles = (files: WebAssets["files"]) => {
  const paths = new Set(Object.keys(files).map((name) => `/${name}`));
  const hash = createHash("sha256");
  for (const [name, body] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(name).update("\0").update(body).update("\0");
  }
  const version = hash.digest("hex").slice(0, 12);

  const versioned = (html: string) =>
    html.replace(/\b(src|href)="(\/[^"?#]+)"/g, (match, attribute, path) =>
      paths.has(path) ? `${attribute}="${path}?v=${version}"` : match,
    );

  return { version, versioned };
};

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );

/** Static instance limits are filled once, when the page is assembled. */
export const renderHomeLimits = (html: string, config: AppConfig): string => {
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
  const values = {
    "%MAX_ITEMS%": number.format(config.maxItems),
    "%ITEM_EXPIRY%": duration(config.itemTtlMs / 1000),
    "%MAX_FILE_SIZE%": bytes(config.maxFileBytes),
    "%MAX_TEXT_SIZE%": bytes(config.maxTextBytes),
    "%SENDS_PER_MINUTE%": number.format(config.sendsPerMinute),
  };
  for (const [placeholder, value] of Object.entries(values)) {
    html = html.replaceAll(placeholder, escapeHtml(value));
  }
  return html;
};

export const renderLogPage = (
  layout: string,
  title: string,
  backHref: string | null,
  jsonHref: string,
  entries: AccessLogEntry[],
): string => {
  const rows = entries
    .map(
      (entry) => `
        <tr>
          <td><code>${escapeHtml(entry.ip)}</code>${locationOf(entry) ? `<small>${escapeHtml(locationOf(entry))}</small>` : ""}</td>
          <td><time datetime="${escapeHtml(entry.lastSeenAt)}">${escapeHtml(entry.lastSeenAt)}</time></td>
          <td>${entry.hits}</td>
          <td class="route"><small>${escapeHtml(entry.lastMethod)}</small><code title="${escapeHtml(entry.lastPath)}">${escapeHtml(entry.lastPath)}</code></td>
          <td class="agent"><span title="${escapeHtml(entry.userAgent)}">${escapeHtml(entry.userAgent || "—")}</span></td>
        </tr>`,
    )
    .join("");

  return composePage(
    layout,
    `<head>
  <title>${escapeHtml(title)} access log · Kurobako</title>
  <script type="module" src="/log.js"></script>
</head>
<main data-loading>
  <div id="page-loading" class="page-loading" role="status" aria-live="polite"><span class="loading-spinner" aria-hidden="true"></span><span>Loading access log…</span></div>
  <p${backHref ? "" : ' id="log-back-row" hidden'}><a${backHref ? "" : ' id="log-back"'} href="${escapeHtml(backHref ?? "#")}">← Back to namespace</a></p>
  <h1>Access log · ${escapeHtml(title)}</h1>
  <p class="intro">
    ${entries.length} IP${entries.length === 1 ? "" : "s"}
    · <a data-icon="json" href="${escapeHtml(jsonHref)}">See JSON</a>
  </p>
  ${
    entries.length
      ? `<div class="table-scroll"><table class="data-table">
          <thead><tr><th>IP</th><th>Last seen (UTC)</th><th>Requests</th><th>Last route</th><th>User agent</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
      : '<p class="empty">No entries.</p>'
  }
</main>`,
  );
};
