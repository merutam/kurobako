// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The same everywhere, so on Cloudflare ops/build.ts serves them as static assets.
import { raw } from "hono/html";
import type { StaticPage } from "../assets";
import { Layout, renderPage, type SiteView } from "./components/layout";
import licensesHtml from "./documents/licenses.html" with { type: "text" };
import protocolHtml from "./documents/protocol.html" with { type: "text" };

// Bun's types describe its HTML loader; the explicit text import yields strings, as in Wrangler.
const text = (value: unknown) => value as string;

/** Links rewritten, so the documents work under a base path. */
const body = (site: SiteView, html: string) =>
  raw(
    html
      .replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, "")
      .replace(/\b(href|src)="\/(?!\/)/g, `$1="${site.basePath}/`),
  );

const DocumentPage = ({
  site,
  title,
  mainClass,
  html,
}: {
  site: SiteView;
  title: string;
  mainClass: string;
  html: string;
}) => (
  <Layout site={site} title={`${title} · Kurobako`} scripts={[]} mainClass={mainClass}>
    {body(site, html)}
  </Layout>
);

export const ProtocolPage = ({ site }: { site: SiteView }) => (
  <DocumentPage site={site} title="Protocol" mainClass="prose" html={text(protocolHtml)} />
);

export const LicensesPage = ({ site }: { site: SiteView }) => (
  <DocumentPage
    site={site}
    title="Licenses"
    mainClass="prose licenses-page"
    html={text(licensesHtml)}
  />
);

export const STATIC_PAGE_RENDERERS: Record<StaticPage, (site: SiteView) => string> = {
  "k/protocol": (site) => renderPage(<ProtocolPage site={site} />),
  "k/licenses": (site) => renderPage(<LicensesPage site={site} />),
};
