// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The site's own pages and documents: home, encryption spec, health, the
// well-known description, stats.
import { LICENSES_PATH, PROTOCOL_PATH, WELL_KNOWN_PATH } from "../routing";
import { renderLicensesPage, renderProtocolPage } from "../views/documents";
import { renderHomePage } from "../views/home";
import { renderNamespacePage } from "../views/namespace";
import type { Api, App } from "./context";

/** The home page's stats, shared by every request to this instance for a little while. */
const STATS_TTL_MS = 30_000;

export const mountSite = (app: App, api: Api) => {
  const { page, pageView, hub, publicConfig, siteView, config } = api;
  // The same for every request: rendered once. On Cloudflare, the protocol and
  // the licenses are usually answered by static assets instead (ops/build.ts).
  const pages = {
    home: renderHomePage(siteView, config),
    protocol: renderProtocolPage(siteView),
    licenses: renderLicensesPage(siteView),
    encrypted: renderNamespacePage(siteView, null, [], config.maxItems),
  };
  let statsCache: { expires: number; body: Promise<Record<string, unknown>> } | null = null;

  app.get("/", (c) => pageView(c, pages.home));
  app.get(PROTOCOL_PATH, (c) => page(c, pages.protocol));
  app.get(LICENSES_PATH, (c) => page(c, pages.licenses));
  // The secret name lives in the URL fragment, which never reaches the server.
  app.get("/e", (c) => pageView(c, pages.encrypted));

  app.get("/k/healthz", (c) => c.json({ ok: true }));
  // What any client needs to talk to this server: its base path, version and
  // rules. Served at the domain's root and under the base path alike.
  app.get(WELL_KNOWN_PATH, (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(publicConfig());
  });
  app.get("/stats.json", async (c) => {
    if (!statsCache || statsCache.expires < Date.now()) {
      statsCache = {
        expires: Date.now() + STATS_TTL_MS,
        // A plain copy: an RPC result must not outlive its request.
        body: hub(c)
          .stats()
          .then((stats) => ({ ...stats })),
      };
      // A failed read must not be served from the cache.
      statsCache.body.catch(() => (statsCache = null));
    }
    c.header("Cache-Control", `public, max-age=${STATS_TTL_MS / 1000}`);
    return c.json(await statsCache.body);
  });
};
