// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { createHash } from "node:crypto";
import packageJson from "../package.json";
import type { SiteView } from "./views/layout";

export type WebAssets = {
  /** App version shown in the page footer. */
  version: string;
  /** Static files served from the site root, keyed by path. */
  files: Record<string, string>;
};

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
  "unlocking.js",
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

/**
 * Pages rendered ahead into public/<page>.html by ops/pages.ts, which
 * Cloudflare serves at /<page> without the Worker (the app renders them too).
 */
export const STATIC_PAGES = ["k/protocol", "k/licenses"] as const;

/** Whether a path inside the site (/common.js) is one of the files above. */
export const isPublicFile = (path: string) =>
  STATIC_FILES.includes(path.slice(1)) || ICON_FILES.includes(path.slice(1));

/** Reads the browser's files from public/; the pages themselves are rendered from src/views/. */
export const loadAssets = async (read: (path: string) => Promise<string>): Promise<WebAssets> => {
  const files = Object.fromEntries(
    await Promise.all(STATIC_FILES.map(async (path) => [path, await read(path)])),
  );
  return { version: packageJson.version, files };
};

/**
 * The static files' content hash. It goes on the pages' script and style
 * URLs (see assetUrl), so a new deployment never pairs a fresh page with a
 * stale file still in some cache.
 */
const staticVersion = (files: WebAssets["files"]) => {
  const hash = createHash("sha256");
  for (const [name, body] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(name).update("\0").update(body).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
};

/** What every page's frame needs: links, versioned asset URLs and the footer. */
export const siteViewOf = (
  assets: WebAssets,
  basePath: string,
  publicConfig: unknown,
): SiteView => {
  const version = staticVersion(assets.files);
  return {
    basePath,
    staticVersion: version,
    appVersion: `${assets.version} (build ${version})`,
    publicConfig,
  };
};
