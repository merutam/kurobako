// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { Child } from "hono/jsx";
import { ASSETS_PATH, type Manifest, STYLES } from "../../assets";
import { Icon } from "./icons";

export type SiteView = {
  basePath: string;
  /** The bundle's files (see src/assets.ts). */
  manifest: Manifest;
  appVersion: string;
  publicConfig: unknown;
};

/** Script data is raw HTML text, so escape < to prevent a closing script tag. */
export const safeJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

/** A bundled file's URL: named by its contents, so cached for good. */
const assetUrl = (site: SiteView, file: string) => `${site.basePath}${ASSETS_PATH}/${file}`;

/** A script or the styles, by name in the bundle's manifest ("home", "styles"). */
const entryOf = (site: SiteView, entry: string) => {
  const found = site.manifest.files[entry];
  if (!found) throw new Error(`The bundle has no ${entry}.`);
  return found;
};

/**
 * A page's scripts, by name (src/client/pages/<name>.js, head/<name>.js): classic ones run as they
 * come, in <head>; modules come with every chunk they import, preloaded, so
 * the browser fetches them all at once rather than one import after another.
 */
const Scripts = ({ site, entries }: { site: SiteView; entries: readonly string[] }) => {
  const chunks = new Set(entries.flatMap((entry) => entryOf(site, entry).preload));
  return (
    <>
      {entries.map((entry) => {
        const { file, kind } = entryOf(site, entry);
        return kind === "module" ? (
          <script type="module" src={assetUrl(site, file)} />
        ) : (
          <script src={assetUrl(site, file)} />
        );
      })}
      {[...chunks].map((file) => (
        <link rel="modulepreload" href={assetUrl(site, file)} />
      ))}
    </>
  );
};

export const Page = ({
  site,
  title,
  scripts,
  config = false,
  data,
  noIndex = false,
  unlocking = false,
  mainClass,
  children,
}: {
  site: SiteView;
  title: string;
  /** The page's scripts, by name in the manifest ("namespace", "read-link"). */
  scripts: readonly string[];
  config?: boolean;
  data?: { id: string; value: unknown };
  noIndex?: boolean;
  unlocking?: boolean;
  mainClass?: string;
  children: Child;
}) => {
  const { basePath } = site;
  return `<!doctype html>\n${String(
    <html lang="en" data-base={basePath}>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="stylesheet" href={assetUrl(site, entryOf(site, STYLES).file)} />
        <script src={assetUrl(site, entryOf(site, "theme").file)} />
        <script src={assetUrl(site, entryOf(site, "scroll-top").file)} defer />
        <link rel="icon" href={`${basePath}/favicon.ico`} sizes="any" />
        <link rel="apple-touch-icon" href={`${basePath}/apple-touch-icon.png`} />
        {noIndex ? <meta name="robots" content="noindex" /> : null}
        <title>{title}</title>
        <Scripts site={site} entries={scripts} />
        {config ? (
          <script
            type="application/json"
            id="config"
            dangerouslySetInnerHTML={{ __html: safeJson(site.publicConfig) }}
          />
        ) : null}
        {data ? (
          <script
            type="application/json"
            id={data.id}
            dangerouslySetInnerHTML={{ __html: safeJson(data.value) }}
          />
        ) : null}
      </head>
      <body>
        <main class={mainClass} data-loading={unlocking ? "" : undefined}>
          <header class="site-header">
            <p class="site-name">
              <a href={`${basePath}/`}>
                <img src={`${basePath}/logo.png`} alt="" width="32" height="32" />
                Kurobako
              </a>
            </p>
            <div class="theme-picker" role="radiogroup" aria-labelledby="theme-picker-label">
              <span id="theme-picker-label" class="theme-picker-label">
                Theme
              </span>
              <label>
                <input type="radio" name="theme" value="auto" checked /> Automatic
              </label>
              <label>
                <input type="radio" name="theme" value="light" /> Light
              </label>
              <label>
                <input type="radio" name="theme" value="dark" /> Dark
              </label>
            </div>
          </header>
          {children}
        </main>
        <footer class="site-footer">
          Kurobako {site.appVersion} · <a href={`${basePath}/k/protocol`}>Protocol</a> ·{" "}
          <a href={`${basePath}/k/licenses`}>Licenses</a> ·{" "}
          <a
            class="external-link"
            href="https://github.com/merutam/kurobako"
            target="_blank"
            rel="noopener"
          >
            Source
            <Icon name="external" size={14} />
          </a>
        </footer>
        <button id="scroll-top" type="button" hidden>
          Top
        </button>
      </body>
    </html>,
  )}`;
};
