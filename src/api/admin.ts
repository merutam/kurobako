// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Api, App } from "./context";

const SESSION_COOKIE = "kurobako_admin";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/** Equal-length digests, so the comparison time reveals nothing about the input. */
const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

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
 * Mounts the dashboard at /a. Its JSON needs a session cookie (set by logging
 * in with the key) or `Authorization: Bearer <key>` for scripts. The key never
 * travels in a URL. Failed logins are counted in the hub, so the lockout
 * holds across every server instance.
 */
export const mountAdmin = (app: App, api: Api, key: string) => {
  const { hub, clientIp, page, pages, log, platformOf, appVersion } = api;
  const { adminSessionHours: sessionHours } = api.config;

  const sign = (expires: string) =>
    createHmac("sha256", key).update(`admin-session:${expires}`).digest("base64url");

  const hasSession = (c: Context) => {
    const [expires, signature] = (getCookie(c, SESSION_COOKIE) ?? "").split(".");
    if (!expires || !signature || Number(expires) < Date.now()) return false;
    return sameSecret(signature, sign(expires));
  };

  const hasBearer = (c: Context) => {
    const header = c.req.header("authorization") ?? "";
    return header.startsWith("Bearer ") && sameSecret(header.slice("Bearer ".length), key);
  };

  // Registered before the routes below so it guards all of them; the page
  // itself and the login are open.
  const OPEN_PATHS = new Set(["/a", "/a/", "/a/login"]);
  app.use("/a/*", async (c, next) => {
    if (OPEN_PATHS.has(c.req.path)) return next();
    c.header("Cache-Control", "no-store");
    if (hasSession(c) || hasBearer(c)) return next();
    return c.json({ error: "Unauthorized." }, 401);
  });

  app.get("/a", (c) => page(c, pages.admin));

  app.post("/a/login", async (c) => {
    const ip = clientIp(c);
    if (await hub(c).loginLockedOut(ip)) {
      return c.json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as { key?: unknown };
    if (typeof body.key !== "string" || !sameSecret(body.key, key)) {
      await hub(c).loginFailed(ip);
      log(c, "warn", `Admin login failed from ${ip}.`);
      return c.json({ error: "Wrong key." }, 401);
    }

    await hub(c).loginSucceeded(ip);
    const expires = String(Date.now() + sessionHours * 3_600_000);
    setCookie(c, SESSION_COOKIE, `${expires}.${sign(expires)}`, {
      path: "/a",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      maxAge: sessionHours * 3_600,
    });
    log(c, "info", `Admin login from ${ip}.`);
    return c.json({ ok: true });
  });

  app.post("/a/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/a", secure: true });
    return c.json({ ok: true });
  });

  app.get("/a/overview", async (c) => {
    const platform = platformOf(c);
    return c.json({
      version: appVersion,
      ...platform.deployment(c),
      ...(await hub(c).overview()),
      logsUrl: platform.logsUrl,
      logsHint: platform.logsHint,
    });
  });

  app.get("/a/namespaces", async (c) => c.json(await hub(c).namespacesPage(pageQuery(c))));
};
