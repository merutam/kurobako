// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
//
// Everything about a namespace sits under short, fixed suffixes so it can be typed by hand:
//
//   GET    /<ns>              the page
//   GET    /<ns>/ls           the queue as JSON
//   POST   /<ns>/new          sends an item
//   PUT    /<ns>/<name>       sends a file under that name (`curl -T file /<ns>/`)
//   GET    /<ns>/<item>       its contents (/c too); /d downloads it
//   GET    /<ns>/<item>.json  its details and a share link
//   GET    /<ns>/<item>/s     a share link, as text (POST too)
//   POST   /<ns>/<item>/e     replaces a text
//   POST   /<ns>/<item>/n     renames it
//   DELETE /<ns>/<item>       deletes it
//   GET    /<ns>/log          who opened it; log.json for JSON
//   GET    /<ns>/live         a WebSocket with every change
//
// Encrypted namespaces live at /e/<id>. <item> is a position (1 is the newest), an ID or a name.
import { Hono } from "hono";
import { accessGuard, accessRoutes } from "./api/access";
import { adminGuard, adminRoutes } from "./api/admin";
import { archiveRoutes } from "./api/archives";
import { createContents } from "./api/contents";
import { type AppEnv, createContext, jsonError } from "./api/context";
import { itemRoutes } from "./api/items";
import { missLimit } from "./api/misses";
import { namespaceRoutes } from "./api/namespaces";
import { shareRoutes } from "./api/shares";
import { siteRoutes } from "./api/site";
import { createUploads } from "./api/uploads";
import { viewRoutes } from "./api/views";
import type { WebAssets } from "./assets";
import type { AppConfig } from "./config";
import { logError } from "./core/log";
import { ADMIN_PATH, sitePath } from "./core/routing";
import type { Platform } from "./runtime/platform";

export type { AppEnv };

/** Requests outside the base path match nothing. */
const OUTSIDE = "/\0";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export const createApp = (config: AppConfig, assets: WebAssets, platform: Platform) => {
  // Routes are written from the site's root: base path and trailing slash are stripped here.
  const app = new Hono<AppEnv>({
    getPath: (request) => sitePath(config.basePath, new URL(request.url).pathname) ?? OUTSIDE,
  });
  const api = createContext(config, assets, platform);

  app.use("*", async (c, next) => {
    await next();
    // A WebSocket upgrade response cannot carry or change headers.
    if (c.res.status === 101) return;
    const response = new Response(c.res.body, c.res);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!response.headers.has(name)) response.headers.set(name, value);
    }
    c.res = response;
  });

  // Middleware first, then fixed paths, items last: an item can have any name.
  // A private instance turns away whoever has no session before anything else.
  if (config.accessKey) app.use(accessGuard(api, config.accessKey));
  app.use(missLimit(api));
  // On /a/*, so it guards the admin backups in archives.ts too.
  if (config.adminKey) app.use(`${ADMIN_PATH}/*`, adminGuard(api, config.adminKey));

  const contents = createContents(api);
  const uploads = createUploads(api);
  if (config.accessKey) app.route("/", accessRoutes(api, config.accessKey));
  app.route("/", siteRoutes(api));
  if (config.adminKey) app.route("/", adminRoutes(api, config.adminKey));
  app.route("/", shareRoutes(api, contents));
  app.route("/", viewRoutes(api));
  app.route("/", archiveRoutes(api));
  app.route("/", namespaceRoutes(api, uploads));
  app.route("/", itemRoutes(api, contents, uploads));

  app.notFound((c) => jsonError(c, 404, "Not found."));
  app.onError((error, c) => {
    if (error.message === "Write access denied.") return jsonError(c, 403, error.message);
    if (error.message === "View changed." || error.message === "Too many views.") {
      return jsonError(c, 409, error.message);
    }
    if (
      error.message ===
      "Import into an encrypted namespace with an active view needs view envelopes."
    ) {
      return jsonError(c, 409, error.message);
    }
    if (
      error.message === "Invalid view ID." ||
      error.message === "Missing or invalid view envelope."
    ) {
      return jsonError(c, 400, error.message);
    }
    logError("Request failed", error, { method: c.req.method, path: c.req.path });
    return jsonError(c, 500, "Internal error.");
  });

  return app;
};
