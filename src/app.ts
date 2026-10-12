// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
//
// The app, shared by every platform: the routes in api/, put together. A
// namespace lives at /<name> (or /e/<id> when encrypted) and everything about
// it sits under short, fixed suffixes, so it can all be typed by hand:
//
//   GET    /<ns>              the page
//   GET    /<ns>/ls           the queue as JSON
//   POST   /<ns>/new          sends an item
//   PUT    /<ns>/<name>       sends a file under that name (`curl -T file /<ns>/`)
//   GET    /<ns>/<item>       one item's contents (/c too); /d downloads it
//   GET    /<ns>/<item>.json  its details and a link to share it
//   GET    /<ns>/<item>/s     a link to share it, as text (POST works too)
//   POST   /<ns>/<item>/e     replaces a text's contents
//   POST   /<ns>/<item>/n     renames it
//   DELETE /<ns>/<item>       deletes it
//   GET    /<ns>/log          who opened the namespace; log.json for JSON
//   GET    /<ns>/live         a WebSocket with every change
//
// <item> is an item's position in the queue (1 is the newest), its ID or its name.
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

/** A path no route matches, for requests outside the base path. */
const OUTSIDE = "/\0";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  // A window another site opened, or that opened this one, cannot reach in.
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export const createApp = (config: AppConfig, assets: WebAssets, platform: Platform) => {
  // Routes are written from the site's root; under a base path (/k), /k/aa
  // is /aa. A trailing slash changes nothing: /aa/ is /aa, /aa/ls/ is /aa/ls.
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

  // Each file in api/ gives a group of routes (a Hono app, mounted here with
  // app.route) or a middleware (registered here with app.use). Routes are
  // written with their full paths, so all of them mount at "/".
  //
  // The order matters: middleware first, then fixed paths, items last, since
  // an item can have any name.
  // Before every route: a private instance turns away whoever has no session.
  if (config.accessKey) app.use(accessGuard(api, config.accessKey));
  // Then whoever keeps finding nothing reads nothing for a while.
  app.use(missLimit(api));
  // Everything under /a asks for the admin key, the backups in archives.ts too.
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
