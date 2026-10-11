// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Looking for things that are not there. A person rarely opens a namespace,
// item or share link that does not exist; a script guessing names does so
// all the time. Past MISSES_PER_MINUTE of those, a client reads nothing at
// all for the rest of the minute: refusing only the misses would tell it
// which names exist, at full speed.
//
// A miss is a 404 on a namespace or share path, or an empty queue where a
// route says so (c.set("miss", true)): /ls, the live queue and backups,
// which answer an empty list for a namespace that does not exist.
import { routeOf } from "../core/routing";
import { type Api, type App, jsonError } from "./context";

export const mountMissLimit = (app: App, api: Api) => {
  const { platform, limitKey } = api;
  app.use("*", async (c, next) => {
    // Only paths that lead to a namespace or a share link.
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
