// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A person rarely opens names that do not exist; a script guessing them does
// all the time. Past MISSES_PER_MINUTE, the client reads nothing for the rest
// of the minute: refusing only the misses would tell it which names exist.
//
// Routes that answer an empty list for a missing namespace (ls, live,
// backups) flag it with c.set("miss", true).
import { createMiddleware } from "hono/factory";
import { routeOf } from "../core/routing";
import { type Api, type AppEnv, jsonError } from "./context";

export const missLimit = (api: Api) => {
  const { platform, limitKey } = api;
  return createMiddleware<AppEnv>(async (c, next) => {
    if (routeOf(c.req.path) === null) return next();
    const key = limitKey(c);
    if (platform.missesExceeded(c, key)) {
      c.header("Retry-After", "60");
      return jsonError(
        c,
        429,
        "Too many requests for things that are not there. Try again in a minute.",
      );
    }
    await next();
    if (c.res.status === 404 || c.get("miss")) await platform.recordMiss(c, key);
  });
};
