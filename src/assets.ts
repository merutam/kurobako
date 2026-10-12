// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Bundles are named by their contents, so they are cached for good.
import packageJson from "../package.json";
import type { SiteView } from "./pages/components/layout";

export const ASSETS_PATH = "/k/assets";
export const MANIFEST_FILE = "manifest.json";

export const STYLES = "styles";
/** Kept as written, comments and all: /k/theme starts a theme from it. */
export const TOKENS = "tokens";

export type Manifest = {
  build: string;
  /** Embedded so both servers serve /k/theme without reading files. */
  themes: Record<string, string>;
  /** `preload`: the chunks a page imports, fetched all at once. */
  files: Record<
    string,
    { file: string; kind: "module" | "classic" | "style"; preload: readonly string[] }
  >;
};

export type WebAssets = {
  version: string;
  manifest: Manifest;
};

/** Fixed URLs: a Service Worker's scope is where it lives, and scripts download k.mjs by name. */
export const FIXED_FILES = ["sw.js", "k.mjs"];

/** Browsers and iOS ask for these at fixed paths. */
export const ICON_FILES = [
  "favicon.ico",
  "apple-touch-icon.png",
  "logo.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable.png",
];

/** Served by Cloudflare without the Worker (ops/build.ts); the app renders them too. */
export const STATIC_PAGES = ["k/protocol", "k/licenses"] as const;
export type StaticPage = (typeof STATIC_PAGES)[number];

export const isFixedFile = (path: string) =>
  FIXED_FILES.includes(path.slice(1)) || ICON_FILES.includes(path.slice(1));

export const isAssetPath = (path: string) => path.startsWith(`${ASSETS_PATH}/`);

export const loadAssets = async (readManifest: () => Promise<string>): Promise<WebAssets> => ({
  version: packageJson.version,
  manifest: JSON.parse(await readManifest()) as Manifest,
});

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
