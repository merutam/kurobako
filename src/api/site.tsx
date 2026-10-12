// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { Hono } from "hono";
import { LICENSES_PATH, PROTOCOL_PATH, WELL_KNOWN_PATH } from "../core/routing";
import { renderPage } from "../pages/components/layout";
import { LicensesPage, ProtocolPage } from "../pages/documents";
import { HomePage } from "../pages/home";
import { NamespacePage } from "../pages/namespace";
import { SharePage } from "../pages/share";
import { ThemePage } from "../pages/theme";
import { createStats, STATS_TTL_MS } from "../services/stats";
import type { Api, AppEnv } from "./context";

export const siteRoutes = (api: Api) => {
  const app = new Hono<AppEnv>();
  const { page, pageView, publicConfig, siteView, config } = api;
  // Rendered once. On Cloudflare, ops/build.ts usually serves protocol and licenses as assets.
  const pages = {
    home: renderPage(<HomePage site={siteView} config={config} />),
    protocol: renderPage(<ProtocolPage site={siteView} />),
    licenses: renderPage(<LicensesPage site={siteView} />),
    encrypted: renderPage(
      <NamespacePage
        site={siteView}
        name={null}
        queue={{ items: [], revision: 0 }}
        config={config}
      />,
    ),
    share: renderPage(<SharePage site={siteView} />),
    theme: renderPage(<ThemePage site={siteView} />),
  };
  const stats = createStats(api);

  app.get("/", (c) => pageView(c, pages.home));
  app.get(PROTOCOL_PATH, (c) => page(c, pages.protocol));
  app.get(LICENSES_PATH, (c) => page(c, pages.licenses));
  // The secret name lives in the fragment, which never reaches the server.
  app.get("/e", (c) => pageView(c, pages.encrypted));

  app.get("/k/healthz", (c) => c.json({ ok: true }));
  // sw.js takes the shared data first; this only runs when it is not installed yet.
  app.post("/k/share", (c) => c.redirect(`${config.basePath}/k/share?lost`, 303));
  app.get("/k/share", (c) => page(c, pages.share));
  app.get("/k/theme", (c) => page(c, pages.theme));
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
        // sw.js answers this POST, so what is shared stays on the device.
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
  // At the domain's root too, so clients find it without knowing the base path.
  app.get(WELL_KNOWN_PATH, (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(publicConfig);
  });
  app.get("/stats.json", async (c) => {
    c.header("Cache-Control", `public, max-age=${STATS_TTL_MS / 1000}`);
    return c.json(await stats.current());
  });
  return app;
};
