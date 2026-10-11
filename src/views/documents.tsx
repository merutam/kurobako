// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The protocol and the licenses: the same for every request and every
// instance, so on Cloudflare they are built ahead into public/ (ops/pages.ts)
// and served as static assets, without the Worker.
import { raw } from "hono/html";
import { iconTree } from "../../public/icons.js";
import { h } from "./html";
import { Page, type SiteView } from "./layout";
import licensesHtml from "./templates/licenses.html" with { type: "text" };
import protocolHtml from "./templates/protocol.html" with { type: "text" };

// Bun's HTMLBundle type describes its default HTML loader. The explicit text
// import above instead yields strings, as it does in Wrangler.
const text = (value: unknown) => value as string;

const EXTERNAL = String(iconTree(h, "external", 14));

/** A document's body: its leading comments out, its links under the base path. */
const body = (site: SiteView, html: string) =>
  raw(
    html
      .replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, "")
      .replace(/\b(href|src)="\/(?!\/)/g, `$1="${site.basePath}/`)
      // Links to other sites are marked as such, as common.js marks the pages' own.
      .replace(/(<a class="external-link"[^>]*>[\s\S]*?)<\/a>/g, `$1${EXTERNAL}</a>`),
  );

const renderDocument = (site: SiteView, title: string, mainClass: string, html: string) =>
  Page({
    site,
    title: `${title} · Kurobako`,
    // No script: the links to other sites come marked (theme.js is the layout's).
    scripts: [],
    mainClass,
    children: body(site, html),
  });

export const renderProtocolPage = (site: SiteView) =>
  renderDocument(site, "Protocol", "prose", text(protocolHtml));

export const renderLicensesPage = (site: SiteView) =>
  renderDocument(site, "Licenses", "prose licenses-page", text(licensesHtml));
