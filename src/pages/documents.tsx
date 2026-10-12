// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The protocol and the licenses: the same for every request and every
// instance, so on Cloudflare they are built ahead into dist/ (ops/build.ts)
// and served as static assets, without the Worker.
import { raw } from "hono/html";
import type { StaticPage } from "../assets";
import { Layout, renderPage, type SiteView } from "./components/layout";
import licensesHtml from "./documents/licenses.html" with { type: "text" };
import protocolHtml from "./documents/protocol.html" with { type: "text" };

// Bun's HTMLBundle type describes its default HTML loader. The explicit text
// import above instead yields strings, as it does in Wrangler.
const text = (value: unknown) => value as string;

/** A document's body: its leading comments out, its links under the base path. */
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
  <Layout
    site={site}
    title={`${title} · Kurobako`}
    // No script but the layout's: links to other sites are marked by the styles.
    scripts={[]}
    mainClass={mainClass}
  >
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

/** The pages ops/build.ts renders ahead, by their path (see STATIC_PAGES). */
export const STATIC_PAGE_RENDERERS: Record<StaticPage, (site: SiteView) => string> = {
  "k/protocol": (site) => renderPage(<ProtocolPage site={site} />),
  "k/licenses": (site) => renderPage(<LicensesPage site={site} />),
};
