// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A private instance (ACCESS_KEY set): every request needs a session, opened
// by logging in at /k/login, or `Authorization: Bearer <key>` for scripts.
// Open to anyone: the login itself, the description at /.well-known/kurobako,
// the protocol, the health check, the admin dashboard (it has its own key)
// and, unless PUBLIC_SHARES is false, share links, which open one item each.
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

/** The session both the guard and the login use; signed with the key, so it holds on every server. */
const accessSession = (api: Api, key: string) => {
  const sessions = signedSessions(key, "access-session");
  // The whole site, and only it under a base path; Lax, so a link from
  // elsewhere into the site still finds the session.
  const cookie: SessionCookie = {
    name: SESSION_COOKIE,
    path: api.config.basePath || "/",
    sameSite: "Lax",
    ms: api.config.accessSessionDays * DAY_MS,
  };
  return { sessions, cookie };
};

/** Turns away whoever has no session; registered before every route. */
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
    // A person gets the login, then comes back here; a script gets the reason.
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

/** Logging in and out. */
export const accessRoutes = (api: Api, key: string) => {
  const app = new Hono<AppEnv>();
  const { page, config, siteView } = api;
  const { sessions, cookie } = accessSession(api, key);

  // Where to go after logging in comes in ?next=, put there by the guard.
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
