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
//   GET    /<ns>/<item>       one item's contents; /d downloads it
//   GET    /<ns>/<item>.json  its details and a link to share it
//   GET    /<ns>/<item>/s     a link to share it, as text (POST works too)
//   POST   /<ns>/<item>/n     renames it
//   DELETE /<ns>/<item>       deletes it
//   GET    /<ns>/log          who opened the namespace; log.json for JSON
//   GET    /<ns>/live         a WebSocket with every change
//
// <item> is an item's position in the queue (1 is the newest), its ID or its name.
import { Hono } from "hono";
import { mountAdmin } from "./api/admin";
import { createContents } from "./api/contents";
import { type AppContext, type AppEnv, createContext, jsonError } from "./api/context";
import { mountItems } from "./api/items";
import { mountNamespaces } from "./api/namespaces";
import { mountShares } from "./api/shares";
import { mountSite } from "./api/site";
import { createUploads } from "./api/uploads";
import type { AppConfig } from "./config";
import type { WebAssets } from "./pages";
import type { Platform } from "./platform";

export type { AppEnv };

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const ERROR_FIELDS = new Set(["name", "message", "stack", "cause"]);

/** Keeps runtime-specific fields such as Bun's S3 error code in structured logs. */
const errorFields = (error: Error) => {
  const fields: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(error)) {
    if (!ERROR_FIELDS.has(name)) fields[name] = Reflect.get(error, name);
  }
  return fields;
};

export const createApp = (
  config: AppConfig,
  assets: WebAssets,
  platformOf: (c: AppContext) => Platform,
) => {
  // A trailing slash changes nothing: /aa/ is /aa, /aa/ls/ is /aa/ls.
  const app = new Hono<AppEnv>({ strict: false });
  const api = createContext(config, assets, platformOf);
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
  mountSite(app, api);
  if (config.adminKey) mountAdmin(app, api, config.adminKey);
  mountShares(app, api, contents);
  mountNamespaces(app, api, createUploads(api));
  mountItems(app, api, contents);

  app.notFound((c) => jsonError(c, 404, "Not found."));
  app.onError((error, c) => {
    console.error({
      message: error.message,
      name: error.name,
      ...errorFields(error),
      method: c.req.method,
      path: c.req.path,
      stack: error.stack ?? "",
      ...(error.cause === undefined ? {} : { cause: error.cause }),
      ...(error.stack ? { stack: error.stack } : {}),
      error,
    });
    return jsonError(c, 500, "Internal error.");
  });

  return app;
};
