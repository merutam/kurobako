// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { ADMIN_PATH } from "../core/routing";
import { renderAdminPage } from "../pages/admin";
import { type Api, type AppEnv, jsonError } from "./context";
import { hasBearer, loginWith, logoutOf, type SessionCookie, signedSessions } from "./session";

const SESSION_COOKIE = "kurobako_admin";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

const integerQuery = (c: Context, name: string, fallback: number, max: number) => {
  const value = Number(c.req.query(name));
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
};

/** Lists are paged so the dashboard never renders thousands of rows at once. */
const pageQuery = (c: Context) => ({
  limit: Math.max(1, integerQuery(c, "limit", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)),
  offset: integerQuery(c, "offset", 0, Number.MAX_SAFE_INTEGER),
  search: (c.req.query("q") ?? "").trim(),
});

/**
 * The dashboard's session: a cookie set by logging in with the key, or
 * `Authorization: Bearer <key>` for scripts. The key never travels in a URL.
 * Sessions are signed with the key, so they hold on every server sharing it.
 */
const adminSession = (api: Api, key: string) => {
  const sessions = signedSessions(key, "admin-session");
  // Sent to the admin's routes only, under the site's base path.
  const cookie: SessionCookie = {
    name: SESSION_COOKIE,
    path: `${api.config.basePath}${ADMIN_PATH}`,
    sameSite: "Strict",
    ms: api.config.adminSessionHours * 3_600_000,
  };
  const hasSession = (c: Context) => sessions.valid(getCookie(c, SESSION_COOKIE));
  return { sessions, cookie, hasSession };
};

/**
 * Guards everything under /a, including the instance's backups (archives.ts);
 * the page itself and the login are open.
 */
export const adminGuard = (api: Api, key: string) => {
  const { hasSession } = adminSession(api, key);
  const OPEN_PATHS = new Set([ADMIN_PATH, `${ADMIN_PATH}/`, `${ADMIN_PATH}/login`]);
  return createMiddleware<AppEnv>(async (c, next) => {
    if (OPEN_PATHS.has(c.req.path)) return next();
    c.header("Cache-Control", "no-store");
    if (hasSession(c) || hasBearer(c, key)) return next();
    return jsonError(c, 401, "Unauthorized.");
  });
};

/**
 * The dashboard at /a. Failed logins are counted in the hub of the server
 * that gets them (behind src/runtime/bun/router.ts, always the first).
 */
export const adminRoutes = (api: Api, key: string) => {
  const app = new Hono<AppEnv>();
  const { hub, page, platform, appVersion, siteView } = api;
  const { sessions, cookie, hasSession } = adminSession(api, key);

  const overview = async (c: Context) => {
    return {
      version: appVersion,
      ...platform.deployment(c),
      ...(await hub().overview()),
      maxStorageBytes: api.config.maxStorageBytes,
      logsUrl: platform.logsUrl,
      logsHint: platform.logsHint,
    };
  };
  const namespacesPage = (c: Context) => hub().namespacesPage(pageQuery(c));

  // With a session, the page comes with what the dashboard would ask for first.
  app.get(ADMIN_PATH, async (c) => {
    if (!hasSession(c)) return page(c, renderAdminPage(siteView, null));
    c.header("Cache-Control", "no-store");
    const [first, namespaces] = await Promise.all([overview(c), namespacesPage(c)]);
    return c.html(renderAdminPage(siteView, { overview: first, namespaces }));
  });

  const dashboard = `${api.config.basePath}${ADMIN_PATH}`;
  app.post(
    `${ADMIN_PATH}/login`,
    loginWith(api, key, sessions, cookie, "Admin login", {
      page: (error) => renderAdminPage(siteView, null, error),
      next: () => dashboard,
    }),
  );
  app.post(`${ADMIN_PATH}/logout`, logoutOf(cookie, dashboard));

  app.get(`${ADMIN_PATH}/overview`, async (c) => c.json(await overview(c)));
  app.get(`${ADMIN_PATH}/namespaces`, async (c) => c.json(await namespacesPage(c)));
  return app;
};
