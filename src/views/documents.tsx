// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The protocol and the licenses: the same for every request and every
// instance, so on Cloudflare they are built ahead into public/ (ops/pages.ts)
// and served as static assets, without the Worker.
import { raw } from "hono/html";
import { Page, type SiteView } from "./layout";
import licensesHtml from "./templates/licenses.html" with { type: "text" };
import protocolHtml from "./templates/protocol.html" with { type: "text" };

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

const renderDocument = (site: SiteView, title: string, mainClass: string, html: string) =>
  Page({
    site,
    title: `${title} · Kurobako`,
    // No script of its own: common.js marks the links to other sites.
    scripts: [{ path: "/common.js", module: true }],
    mainClass,
    children: body(site, html),
  });

export const renderProtocolPage = (site: SiteView) =>
  renderDocument(site, "Protocol", "prose", text(protocolHtml));

export const renderLicensesPage = (site: SiteView) =>
  renderDocument(site, "Licenses", "prose licenses-page", text(licensesHtml));
