// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What the pages load. The browser's code lives in public/ as source; it is
// bundled (src/bun/bundle.ts) into files named by their contents, served at
// /k/assets/ and cached for good. A manifest says which file is which.
import packageJson from "../package.json";
import type { SiteView } from "./views/layout";

/** Where the bundled scripts and styles are served, inside the site. */
export const ASSETS_PATH = "/k/assets";
/** The manifest, in ASSETS_PATH: written by the build, read by the server at start. */
export const MANIFEST_FILE = "manifest.json";

/**
 * The bundle's entries, by their source in public/. Modules are the pages'
 * own scripts; classic scripts run in <head> before the first paint (theme.js,
 * access.js) or deferred (scroll-top.js); the styles are joined into one file.
 */
export const ENTRIES = {
  module: [
    "home.js",
    "namespaces/index.js",
    "view.js",
    "item.js",
    "admin.js",
    "login.js",
    "log.js",
  ],
  classic: ["theme.js", "scroll-top.js", "access.js"],
  style: ["tokens.css", "styles.css"],
} as const;
/** The styles' entry in the manifest, for both files joined. */
export const STYLES = "styles.css";

export type Manifest = {
  /** A hash of every file built, shown in the footer. */
  build: string;
  /** By entry (as in ENTRIES): its file in ASSETS_PATH, and the chunks it imports. */
  files: Record<
    string,
    { file: string; kind: "module" | "classic" | "style"; preload: readonly string[] }
  >;
};

export type WebAssets = {
  /** App version shown in the page footer. */
  version: string;
  manifest: Manifest;
};

/**
 * Files in public/ served as they are, at fixed URLs: the Service Worker
 * (its scope is where it lives) and k.mjs, which scripts download by name.
 */
export const FIXED_FILES = ["sw.js", "k.mjs"];

/** Binary files served as they are at /<path>: the icons browsers and iOS ask for. */
export const ICON_FILES = ["favicon.ico", "apple-touch-icon.png", "logo.png"];

/**
 * Pages rendered ahead by ops/build.ts, which Cloudflare serves at /<page>
 * without the Worker (the app renders them too).
 */
export const STATIC_PAGES = ["k/protocol", "k/licenses"] as const;

/** Whether a path inside the site (/k.mjs) is one of the fixed files above. */
export const isFixedFile = (path: string) =>
  FIXED_FILES.includes(path.slice(1)) || ICON_FILES.includes(path.slice(1));

/** Whether a path inside the site is a bundled file (/k/assets/index-1a2b.js). */
export const isAssetPath = (path: string) => path.startsWith(`${ASSETS_PATH}/`);

/** What the server needs of the build: the manifest, read once at start. */
export const loadAssets = async (readManifest: () => Promise<string>): Promise<WebAssets> => ({
  version: packageJson.version,
  manifest: JSON.parse(await readManifest()) as Manifest,
});

/** What every page's frame needs: links, asset URLs and the footer. */
export const siteViewOf = (
  assets: WebAssets,
  basePath: string,
  publicConfig: unknown,
): SiteView => ({
  basePath,
  manifest: assets.manifest,
  appVersion: `${assets.version} (build ${assets.manifest.build})`,
  publicConfig,
});
