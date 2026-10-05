// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { Context } from "hono";

export type AccessEvent = {
  ip: string;
  lastMethod: string;
  lastPath: string;
  userAgent: string;
  country: string | null;
  /** State or province. */
  region: string | null;
  city: string | null;
};

export type AccessLogEntry = Omit<AccessEvent, "region" | "city"> & {
  firstSeenAt: string;
  lastSeenAt: string;
  hits: number;
  region: string | null;
  city: string | null;
};

/** One request's visit, as a namespace's access log records it. */
export const accessEvent = (
  c: Context,
  client: Pick<AccessEvent, "ip" | "country" | "region" | "city">,
): AccessEvent => ({
  ...client,
  lastMethod: c.req.method,
  lastPath: c.req.path,
  userAgent: c.req.header("user-agent") || "",
});

export const locationOf = (entry: Pick<AccessEvent, "city" | "region" | "country">) =>
  [entry.city, entry.region, entry.country].filter(Boolean).join(", ");
