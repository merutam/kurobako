// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A private instance (ACCESS_KEY set): every request needs a session, opened
// by logging in at /k/login, or `Authorization: Bearer <key>` for scripts.
// Open to anyone: the login itself, the description at /.well-known/kurobako,
// the protocol, the health check, the admin dashboard (it has its own key)
// and, unless PUBLIC_SHARES is false, share links, which open one item each.
import { getCookie } from "hono/cookie";
import { ADMIN_PATH, PROTOCOL_PATH, WELL_KNOWN_PATH } from "../routing";
import { type Api, type App, type AppContext, jsonError } from "./context";
import { hasBearer, loginWith, logoutOf, type SessionCookie, signedSessions } from "./session";

const SESSION_COOKIE = "kurobako_access";
export const LOGIN_PATH = "/k/login";
const DAY_MS = 86_400_000;

export const mountAccess = (app: App, api: Api, key: string) => {
  const { page, pages, config } = api;
  const sessions = signedSessions(key, "access-session");
  // The whole site, and only it under a base path; Lax, so a link from
  // elsewhere into the site still finds the session.
  const cookie: SessionCookie = {
    name: SESSION_COOKIE,
    path: config.basePath || "/",
    sameSite: "Lax",
    ms: config.accessSessionDays * DAY_MS,
  };

  const isOpen = (path: string) =>
    path === LOGIN_PATH ||
    path === WELL_KNOWN_PATH ||
    path === PROTOCOL_PATH ||
    path === "/k/healthz" ||
    path === ADMIN_PATH ||
    path.startsWith(`${ADMIN_PATH}/`) ||
    (config.publicShares && path.startsWith("/i/"));

  const allowed = (c: AppContext) =>
    sessions.valid(getCookie(c, SESSION_COOKIE)) || hasBearer(c, key);

  app.use("*", async (c, next) => {
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

  app.get(LOGIN_PATH, (c) => page(c, pages.login));

  app.post(LOGIN_PATH, loginWith(api, key, sessions, cookie, "Login"));
  app.post("/k/logout", logoutOf(cookie));
};
