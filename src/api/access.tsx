// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// ACCESS_KEY makes the instance private. The few open paths are what a
// visitor needs to log in, and what has its own protection (admin, share links).
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { ADMIN_PATH, LICENSES_PATH, PROTOCOL_PATH, WELL_KNOWN_PATH } from "../core/routing";
import { renderPage } from "../pages/components/layout";
import { LoginPage } from "../pages/login";
import { type Api, type AppContext, type AppEnv, jsonError } from "./context";
import {
  hasBearer,
  insidePath,
  loginWith,
  logoutOf,
  type SessionCookie,
  signedSessions,
} from "./session";

const SESSION_COOKIE = "kurobako_access";
export const LOGIN_PATH = "/k/login";
const DAY_MS = 86_400_000;

const accessSession = (api: Api, key: string) => {
  const sessions = signedSessions(key, "access-session");
  // Lax: a link from another site into this one keeps the session.
  const cookie: SessionCookie = {
    name: SESSION_COOKIE,
    path: api.config.basePath || "/",
    sameSite: "Lax",
    ms: api.config.accessSessionDays * DAY_MS,
  };
  return { sessions, cookie };
};

export const accessGuard = (api: Api, key: string) => {
  const { config } = api;
  const { sessions } = accessSession(api, key);

  const isOpen = (path: string) =>
    path === LOGIN_PATH ||
    path === WELL_KNOWN_PATH ||
    path === PROTOCOL_PATH ||
    path === LICENSES_PATH ||
    path === "/k/healthz" ||
    path === ADMIN_PATH ||
    path.startsWith(`${ADMIN_PATH}/`) ||
    (config.publicShares && (path.startsWith("/i/") || path.startsWith("/v/")));

  const allowed = (c: AppContext) =>
    sessions.valid(getCookie(c, SESSION_COOKIE)) || hasBearer(c, key);

  return createMiddleware<AppEnv>(async (c, next) => {
    if (isOpen(c.req.path) || allowed(c)) return next();
    // A person can log in and come back; a script needs the reason.
    const wantsPage =
      c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html");
    if (wantsPage) {
      const back = c.req.path + new URL(c.req.url).search;
      return c.redirect(`${config.basePath}${LOGIN_PATH}?next=${encodeURIComponent(back)}`);
    }
    return jsonError(
      c,
      401,
      `This Kurobako is private: log in at ${LOGIN_PATH}, or send Authorization: Bearer <key>.`,
    );
  });
};

export const accessRoutes = (api: Api, key: string) => {
  const app = new Hono<AppEnv>();
  const { page, config, siteView } = api;
  const { sessions, cookie } = accessSession(api, key);

  app.get(LOGIN_PATH, (c) =>
    page(c, renderPage(<LoginPage site={siteView} next={insidePath(c.req.query("next"))} />)),
  );
  app.post(
    LOGIN_PATH,
    loginWith(api, key, sessions, cookie, "Login", {
      page: (error, next) => renderPage(<LoginPage site={siteView} error={error} next={next} />),
      next: (next) => `${config.basePath}${next}`,
    }),
  );
  app.post("/k/logout", logoutOf(cookie, `${config.basePath}${LOGIN_PATH}`));
  return app;
};
