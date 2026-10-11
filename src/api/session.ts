// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Logins without server-side state: a session is its expiry time, signed with
// the key it was opened with. Any server holding the key can check it, and
// changing the key ends every session.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { clientKey } from "../core/visits";
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

/**
 * What a login sent, from its body (null bytes: too large): JSON from a
 * script, {"key": "…"}, or a page's form, key=…&next=….
 */
export const parseLogin = (
  bytes: Uint8Array | null,
  form: boolean,
): { key?: unknown; next?: unknown } => {
  if (!bytes) return {};
  if (form) return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(bytes)));
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

/** Whether a request comes from a page's own form, rather than a script. */
const fromForm = (c: AppContext) =>
  (c.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded");

/** A path inside this site to go to after a login, never another site. */
export const insidePath = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";

/**
 * A login with `key`, and a session cookie out. A script sends {"key": "…"}
 * and gets JSON; a page's form posts key (and next) and is sent on to
 * `next` (inside the site), or gets its page again from `form`, with the
 * reason. Failed attempts are counted per address in the hub, which turns
 * that address away for a while after too many. `label` names it in the logs.
 */
export const loginWith = (
  api: Api,
  key: string,
  sessions: ReturnType<typeof signedSessions>,
  cookie: SessionCookie,
  label: string,
  form: { page: (error: string, next: string) => string; next: (next: string) => string },
) => {
  const { hub, clientIp, log, page } = api;
  return async (c: AppContext) => {
    const ip = clientIp(c);
    const isForm = fromForm(c);
    const body = parseLogin(await readLimited(c, MAX_LOGIN_BYTES), isForm);
    const next = insidePath(body.next);
    const refuse = (status: 401 | 429, error: string) => {
      if (!isForm) return jsonError(c, status, error);
      c.status(status);
      return page(c, form.page(error, next));
    };
    // Failed attempts are counted like sends: an IPv6 network as one.
    const who = clientKey(ip);
    if (await hub().loginLockedOut(who)) {
      return refuse(429, "Too many failed attempts. Try again in 15 minutes.");
    }
    if (typeof body.key !== "string" || !sameSecret(body.key, key)) {
      await hub().loginFailed(who);
      log(c, "warn", `${label} failed from ${ip}.`);
      return refuse(401, "Wrong key.");
    }
    await hub().loginSucceeded(who);
    setCookie(c, cookie.name, sessions.issue(cookie.ms), {
      path: cookie.path,
      httpOnly: true,
      secure: true,
      sameSite: cookie.sameSite,
      maxAge: cookie.ms / 1000,
    });
    log(c, "info", `${label} from ${ip}.`);
    return isForm ? c.redirect(form.next(next), 303) : c.json({ ok: true });
  };
};

/** The way out: the session cookie goes; a page's form is sent to `then`. */
export const logoutOf = (cookie: SessionCookie, then: string) => (c: AppContext) => {
  deleteCookie(c, cookie.name, { path: cookie.path, secure: true });
  return fromForm(c) ? c.redirect(then, 303) : c.json({ ok: true });
};
