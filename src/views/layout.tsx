// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { Child } from "hono/jsx";

export type SiteView = {
  basePath: string;
  staticVersion: string;
  appVersion: string;
  publicConfig: unknown;
};

/** Script data is raw HTML text, so escape < to prevent a closing script tag. */
export const safeJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

export const assetUrl = (site: SiteView, path: string) =>
  `${site.basePath}${path}?v=${site.staticVersion}`;

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
  scripts: ReadonlyArray<{ path: string; module?: boolean }>;
  config?: boolean;
  data?: { id: string; value: unknown };
  noIndex?: boolean;
  unlocking?: boolean;
  mainClass?: string;
  children: Child;
}) => {
  const { basePath } = site;
  return `<!doctype html>\n${String(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="stylesheet" href={assetUrl(site, "/tokens.css")} />
        <link rel="stylesheet" href={assetUrl(site, "/styles.css")} />
        <script src={assetUrl(site, "/theme.js")} />
        <script src={assetUrl(site, "/scroll-top.js")} defer />
        <link rel="icon" href={`${basePath}/favicon.ico`} sizes="any" />
        <link rel="apple-touch-icon" href={`${basePath}/apple-touch-icon.png`} />
        {noIndex ? <meta name="robots" content="noindex" /> : null}
        <title>{title}</title>
        {scripts.map(({ path, module }) =>
          module ? (
            <script type="module" src={assetUrl(site, path)} />
          ) : (
            <script src={assetUrl(site, path)} />
          ),
        )}
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
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4" />
            </svg>
          </a>
        </footer>
        <button id="scroll-top" type="button" hidden>
          ↑ Top
        </button>
      </body>
    </html>,
  )}`;
};
