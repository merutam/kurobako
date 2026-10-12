// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { Child } from "hono/jsx";
import { ASSETS_PATH, type Manifest, STYLES } from "../../assets";
import { Icon } from "./icons";

export type SiteView = {
  basePath: string;
  manifest: Manifest;
  appVersion: string;
  publicConfig: unknown;
};

/** Script data is raw HTML text: an unescaped < could close the script tag. */
export const safeJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

const assetUrl = (site: SiteView, file: string) => `${site.basePath}${ASSETS_PATH}/${file}`;

const entryOf = (site: SiteView, entry: string) => {
  const found = site.manifest.files[entry];
  if (!found) throw new Error(`The bundle has no ${entry}.`);
  return found;
};

/** Every chunk a module imports is preloaded, so the browser fetches them at once. */
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

/** Text, so a page the same for every request can be rendered once and kept. */
export const renderPage = (page: Child) => `<!doctype html>\n${String(page)}`;

export const Layout = ({
  site,
  title,
  scripts,
  config = false,
  data,
  noIndex = false,
  decrypting,
  mainClass,
  children,
}: {
  site: SiteView;
  title: string;
  scripts: readonly string[];
  config?: boolean;
  data?: { id: string; value: unknown };
  noIndex?: boolean;
  /** Shown alone until the script calls finishUnlocking, so nothing flashes undecrypted. */
  decrypting?: string;
  mainClass?: string;
  children: Child;
}) => {
  const { basePath } = site;

  return (
    <html lang="en" data-base={basePath}>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="stylesheet" href={assetUrl(site, entryOf(site, STYLES).file)} />
        {/* Before the first paint, so the theme never flashes. */}
        <script src={assetUrl(site, entryOf(site, "site").file)} />
        <link rel="icon" href={`${basePath}/favicon.ico`} sizes="any" />
        <link rel="apple-touch-icon" href={`${basePath}/apple-touch-icon.png`} />
        <link rel="manifest" href={`${basePath}/manifest.webmanifest`} />
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
        <main class={mainClass} data-loading={decrypting ? "" : undefined}>
          <header class="site-header">
            <p class="site-name">
              <a href={`${basePath}/`}>
                {/* A mask, so it takes the theme's accent. */}
                <span class="site-logo" aria-hidden="true" />
                kurobako
              </a>
            </p>
            {/* Hidden without a script: the browser's theme applies then. */}
            <button
              id="theme-toggle"
              class="theme-toggle"
              type="button"
              data-theme-choice="auto"
              hidden
            >
              <Icon name="contrast" size={14} />
              <Icon name="sun" size={14} />
              <Icon name="moon" size={14} />
              theme: <span id="theme-name">auto</span>
            </button>
          </header>
          {scripts.length ? (
            <noscript>
              <p class="noscript">
                This page needs JavaScript. Without it, plain namespaces work with curl, as{" "}
                <a href={`${basePath}/k/protocol`}>the protocol</a> shows, and encrypted ones with{" "}
                <a href={`${basePath}/k.mjs`}>k.mjs</a>, its command-line client.
              </p>
            </noscript>
          ) : null}
          {decrypting ? (
            <div id="page-loading" class="page-loading" role="status" aria-live="polite">
              <span>{decrypting}</span>
            </div>
          ) : null}
          {children}
        </main>
        <footer class="site-footer">
          <p>
            Kurobako {site.appVersion} · <a href={`${basePath}/k/protocol`}>Protocol</a> ·{" "}
            <a href={`${basePath}/k/licenses`}>Licenses</a> ·{" "}
            <a href={`${basePath}/k/theme`}>Theme</a> ·{" "}
            <a
              class="external-link"
              href="https://github.com/merutam/kurobako"
              target="_blank"
              rel="noopener"
            >
              Source
            </a>
          </p>
        </footer>
        <button id="scroll-top" type="button" hidden>
          Top
        </button>
      </body>
    </html>
  );
};
