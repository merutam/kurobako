// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Who uses a namespace, as its access log keeps them, and who a limit counts.

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

/**
 * The first of a header's comma-separated values, or undefined: proxies add
 * theirs after the original one (X-Forwarded-For: client, proxy, …).
 */
export const firstValue = (value: string | null | undefined) =>
  value?.split(",")[0]?.trim() || undefined;

/**
 * Who a limit counts, from a client's address. An IPv4 address is one
 * client; an IPv6 one is counted by its /64 network, which a single home or
 * server is given whole, so changing addresses within it changes nothing.
 * IPv4 written as IPv6 (::ffff:1.2.3.4, as dual-stack servers report it) is
 * IPv4. Anything else (such as "unknown") is taken as it is.
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
