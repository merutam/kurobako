// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Logins without server-side state: a session is its expiry time, signed with
// the key it was opened with. Any server holding the key can check it, and
// changing the key ends every session.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { clientKey } from "../request-info";
import { type Api, type AppContext, jsonError, readLimited } from "./context";

/** Equal-length digests, so the comparison time reveals nothing about the input. */
export const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** `Authorization: Bearer <key>`, for scripts. */
export const hasBearer = (c: Context, key: string) => {
  const header = c.req.header("authorization") ?? "";
  return header.startsWith("Bearer ") && sameSecret(header.slice("Bearer ".length), key);
};

/** Sessions for one purpose ("admin-session", "access-session"), so one never opens the other. */
export const signedSessions = (key: string, purpose: string) => {
  const sign = (expires: string) =>
    createHmac("sha256", key).update(`${purpose}:${expires}`).digest("base64url");
  return {
    /** A session value lasting `ms` from now. */
    issue: (ms: number) => {
      const expires = String(Date.now() + ms);
      return `${expires}.${sign(expires)}`;
    },
    valid: (value: string | undefined) => {
      const [expires, signature] = (value ?? "").split(".");
      if (!expires || !signature || Number(expires) < Date.now()) return false;
      return sameSecret(signature, sign(expires));
    },
  };
};

/** A login's body, {"key": "…"}, is small: anything larger is not one. */
export const MAX_LOGIN_BYTES = 4_096;

/** The key a login sent, from its JSON body (null bytes: too large). */
export const parseLogin = (bytes: Uint8Array | null): { key?: unknown } => {
  if (!bytes) return {};
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof body === "object" && body !== null ? (body as { key?: unknown }) : {};
  } catch {
    return {};
  }
};

/** Where a login keeps its session, and for how long. */
export type SessionCookie = {
  name: string;
  /** The paths it is sent to: the whole site, or just the admin's. */
  path: string;
  /** Strict for the admin's; Lax, so links from elsewhere still find a session. */
  sameSite: "Strict" | "Lax";
  ms: number;
};

/**
 * A login with `key`: {"key": "…"} in, a session cookie out. Failed attempts
 * are counted per address in the hub, which turns that address away for a
 * while after too many. `label` names it in the logs.
 */
export const loginWith = (
  api: Api,
  key: string,
  sessions: ReturnType<typeof signedSessions>,
  cookie: SessionCookie,
  label: string,
) => {
  const { hub, clientIp, log } = api;
  return async (c: AppContext) => {
    const ip = clientIp(c);
    // Failed attempts are counted like sends: an IPv6 network as one.
    const who = clientKey(ip);
    if (await hub(c).loginLockedOut(who)) {
      return jsonError(c, 429, "Too many failed attempts. Try again in 15 minutes.");
    }
    const body = parseLogin(await readLimited(c, MAX_LOGIN_BYTES));
    if (typeof body.key !== "string" || !sameSecret(body.key, key)) {
      await hub(c).loginFailed(who);
      log(c, "warn", `${label} failed from ${ip}.`);
      return jsonError(c, 401, "Wrong key.");
    }
    await hub(c).loginSucceeded(who);
    setCookie(c, cookie.name, sessions.issue(cookie.ms), {
      path: cookie.path,
      httpOnly: true,
      secure: true,
      sameSite: cookie.sameSite,
      maxAge: cookie.ms / 1000,
    });
    log(c, "info", `${label} from ${ip}.`);
    return c.json({ ok: true });
  };
};

/** The way out: the session cookie goes. */
export const logoutOf = (cookie: SessionCookie) => (c: AppContext) => {
  deleteCookie(c, cookie.name, { path: cookie.path, secure: true });
  return c.json({ ok: true });
};
