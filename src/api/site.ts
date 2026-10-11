// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The site's own pages and documents: home, encryption spec, health, the
// well-known description, stats.
import { LICENSES_PATH, PROTOCOL_PATH, WELL_KNOWN_PATH } from "../core/routing";
import { renderLicensesPage, renderProtocolPage } from "../pages/documents";
import { renderHomePage } from "../pages/home";
import { renderNamespacePage } from "../pages/namespace";
import { renderSharePage } from "../pages/share";
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
    encrypted: renderNamespacePage(siteView, null, { items: [], revision: 0 }, config),
    share: renderSharePage(siteView),
  };
  let statsCache: { expires: number; body: Promise<Record<string, unknown>> } | null = null;

  app.get("/", (c) => pageView(c, pages.home));
  app.get(PROTOCOL_PATH, (c) => page(c, pages.protocol));
  app.get(LICENSES_PATH, (c) => page(c, pages.licenses));
  // The secret name lives in the URL fragment, which never reaches the server.
  app.get("/e", (c) => pageView(c, pages.encrypted));

  app.get("/k/healthz", (c) => c.json({ ok: true }));
  // The installed app's share target. sw.js takes what is shared before it
  // gets here; without it (not set up yet), the body is never read.
  app.post("/k/share", (c) => c.redirect(`${config.basePath}/k/share?lost`, 303));
  app.get("/k/share", (c) => page(c, pages.share));
  // What makes the site an installable app; its addresses follow the base path.
  app.get("/manifest.webmanifest", (c) => {
    const base = config.basePath;
    const icon = (name: string, size: number, purpose = "any") => ({
      src: `${base}/${name}`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose,
    });
    c.header("Cache-Control", "no-cache");
    c.header("Content-Type", "application/manifest+json");
    return c.body(
      JSON.stringify({
        id: `${base}/`,
        name: "Kurobako",
        short_name: "Kurobako",
        description: "A web clipboard with short queues kept apart by namespace.",
        start_url: `${base}/`,
        scope: `${base}/`,
        display: "standalone",
        background_color: "#121211",
        theme_color: "#121211",
        icons: [
          icon("icon-192.png", 192),
          icon("icon-512.png", 512),
          icon("icon-maskable.png", 512, "maskable"),
        ],
        // In Android's Share menu once installed. sw.js takes the POST and
        // keeps what it brings on the device: it never reaches the server.
        share_target: {
          action: `${base}/k/share`,
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [{ name: "files", accept: ["*/*"] }],
          },
        },
      }),
    );
  });
  // What any client needs to talk to this server: its base path, version and
  // rules. Served at the domain's root and under the base path alike.
  app.get(WELL_KNOWN_PATH, (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(publicConfig);
  });
  app.get("/stats.json", async (c) => {
    if (!statsCache || statsCache.expires < Date.now()) {
      statsCache = {
        expires: Date.now() + STATS_TTL_MS,
        // A plain copy: an RPC result must not outlive its request.
        body: hub()
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
