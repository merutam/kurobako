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
import { mountAccess } from "./api/access";
import { mountAdmin } from "./api/admin";
import { mountArchives } from "./api/archives";
import { createContents } from "./api/contents";
import { type AppEnv, createContext, jsonError } from "./api/context";
import { mountItems } from "./api/items";
import { mountMissLimit } from "./api/misses";
import { mountNamespaces } from "./api/namespaces";
import { mountShares } from "./api/shares";
import { mountSite } from "./api/site";
import { createUploads } from "./api/uploads";
import { mountViews } from "./api/views";
import type { WebAssets } from "./assets";
import type { AppConfig } from "./config";
import { logError } from "./core/log";
import { sitePath } from "./core/routing";
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
  const contents = createContents(api);

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

  // The order matters: fixed paths first, items last, since an item can have
  // any name.
  // Before every route: a private instance turns away whoever has no session.
  if (config.accessKey) mountAccess(app, api, config.accessKey);
  // Then whoever keeps finding nothing reads nothing for a while.
  mountMissLimit(app, api);
  mountSite(app, api);
  if (config.adminKey) mountAdmin(app, api, config.adminKey);
  mountShares(app, api, contents);
  mountViews(app, api);
  mountArchives(app, api);
  const uploads = createUploads(api);
  mountNamespaces(app, api, uploads);
  mountItems(app, api, contents, uploads);

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
