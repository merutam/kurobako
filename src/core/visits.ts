// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

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

export const locationOf = (entry: Pick<AccessEvent, "city" | "region" | "country">) =>
  [entry.city, entry.region, entry.country].filter(Boolean).join(", ");

/** Proxies add theirs after the original (X-Forwarded-For: client, proxy, …). */
export const firstValue = (value: string | null | undefined) =>
  value?.split(",")[0]?.trim() || undefined;

/**
 * IPv6 counts by /64, which one home or server gets whole, so rotating within it changes nothing.
 */
export const clientKey = (ip: string): string => {
  const address = ip.trim().toLowerCase().replace(/%.*$/, "");
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1] as string;
  if (!address.includes(":")) return address;
  const [head = "", tail, extra] = address.split("::");
  if (extra !== undefined) return address;
  const groupsOf = (part: string) => (part ? part.split(":") : []);
  const before = groupsOf(head);
  const after = tail === undefined ? [] : groupsOf(tail);
  const missing = tail === undefined ? 0 : 8 - before.length - after.length;
  const groups = [...before, ...Array<string>(Math.max(0, missing)).fill("0"), ...after];
  if (groups.length < 4 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return address;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
};
