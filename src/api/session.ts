// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Stateless sessions: an expiry signed with the key. Any server with the key checks them, and
// changing the key ends them all.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { clientKey } from "../core/visits";
import { type Api, type AppContext, jsonError, readLimited } from "./context";

/** Equal-length digests, so timing reveals nothing. */
export const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export const hasBearer = (c: Context, key: string) => {
  const header = c.req.header("authorization") ?? "";
  return header.startsWith("Bearer ") && sameSecret(header.slice("Bearer ".length), key);
};

/** Per purpose, so an access session never opens the admin. */
export const signedSessions = (key: string, purpose: string) => {
  const sign = (expires: string) =>
    createHmac("sha256", key).update(`${purpose}:${expires}`).digest("base64url");
  return {
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

/** Anything larger is not a login: refused before parsing. */
export const MAX_LOGIN_BYTES = 4_096;

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

export type SessionCookie = {
  name: string;
  path: string;
  /** Lax for the site, so links from elsewhere keep the session; Strict for the admin. */
  sameSite: "Strict" | "Lax";
  ms: number;
};

/** Forms get redirects and pages; scripts get JSON. */
const fromForm = (c: AppContext) =>
  (c.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded");

/** Never another site: an open redirect would make the login a phishing tool. */
export const insidePath = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";

/** Failed attempts are counted per address in the hub, which locks the address out for a while. */
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
    // Counted like sends, so an IPv6 network cannot rotate addresses.
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

export const logoutOf = (cookie: SessionCookie, then: string) => (c: AppContext) => {
  deleteCookie(c, cookie.name, { path: cookie.path, secure: true });
  return fromForm(c) ? c.redirect(then, 303) : c.json({ ok: true });
};
