// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

export type AppConfig = {
  /**
   * Where the site lives under its domain: "" for the root, or a path such
   * as "/k" to share a domain with another site.
   */
  basePath: string;
  maxFileBytes: number;
  maxTextBytes: number;
  /** Texts no larger than this stay directly in SQLite. */
  inlineTextBytes: number;
  itemTtlMs: number;
  maxItems: number;
  /** How long a namespace may stay empty before its storage is deleted. */
  emptyNamespaceTtlMs: number;
  /** Open live-update sockets allowed per namespace. */
  maxLiveConnections: number;
  /** Sends allowed per client address per minute. */
  sendsPerMinute: number;
  /** The most every item together may take, in bytes; null for no limit. */
  maxStorageBytes: number | null;
  /** Unset disables the admin dashboard at /a. */
  adminKey: string | null;
  adminSessionHours: number;
  /** Set, only those who know it can use the site: a private instance. */
  accessKey: string | null;
  accessSessionDays: number;
  /** In a private instance, whether share links still open for anyone. */
  publicShares: boolean;
};

/** The largest sizes a platform can take; each platform sets its own. */
export type PlatformLimits = {
  maxFileBytes: number;
  maxTextBytes: number;
  /** Largest text that this platform can safely keep directly in SQLite. */
  maxInlineTextBytes: number;
};

/** Used by self-hosted platforms, where the operator chooses practical limits. */
const UNBOUNDED_LIMITS: PlatformLimits = {
  // Leave room for protocol overhead while staying within safe integers.
  maxFileBytes: Number.MAX_SAFE_INTEGER - 1_000_000,
  maxTextBytes: Number.MAX_SAFE_INTEGER - 1_000_000,
  maxInlineTextBytes: Number.MAX_SAFE_INTEGER - 1_000_000,
};

/** Long enough that guessing it, even without the login rate limit, is hopeless. */
export const ADMIN_KEY_MIN_LENGTH = 32;
/**
 * The key to a private instance is typed on phones too, so it may be shorter;
 * failed logins are limited per address all the same.
 */
export const ACCESS_KEY_MIN_LENGTH = 16;

type Vars = Record<string, unknown>;

const integer = (
  vars: Vars,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = vars[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const accessKey = (vars: Vars): string | null => {
  const key = typeof vars.ACCESS_KEY === "string" ? vars.ACCESS_KEY.trim() : "";
  if (!key) return null;
  if (key.length < ACCESS_KEY_MIN_LENGTH) {
    throw new Error(`ACCESS_KEY must have at least ${ACCESS_KEY_MIN_LENGTH} characters.`);
  }
  return key;
};

const flag = (vars: Vars, name: string, fallback: boolean): boolean => {
  const raw = typeof vars[name] === "string" ? (vars[name] as string).trim().toLowerCase() : "";
  if (!raw) return fallback;
  if (["1", "true", "yes"].includes(raw)) return true;
  if (["0", "false", "no"].includes(raw)) return false;
  throw new Error(`${name} must be true or false.`);
};

const adminKey = (vars: Vars): string | null => {
  const key = typeof vars.ADMIN_KEY === "string" ? vars.ADMIN_KEY.trim() : "";
  if (!key) return null;
  if (key.length < ADMIN_KEY_MIN_LENGTH) {
    throw new Error(
      `ADMIN_KEY must have at least ${ADMIN_KEY_MIN_LENGTH} characters; try: head -c 32 /dev/urandom | base64`,
    );
  }
  return key;
};

const basePath = (vars: Vars): string => {
  const raw = typeof vars.BASE_PATH === "string" ? vars.BASE_PATH.trim() : "";
  // "k", "/k" and "/k/" all mean /k.
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  const path = trimmed ? `/${trimmed}` : "";
  if (path && !/^(?:\/[A-Za-z0-9._~-]+)+$/.test(path)) {
    throw new Error("BASE_PATH must be a path such as /k (letters, digits, . _ ~ -).");
  }
  return path;
};

/**
 * Reads the settings from environment variables (or a Worker's vars and
 * secrets). The defaults are the same everywhere; how far the sizes may go is
 * the platform's `limits`.
 */
export const loadConfig = (env: object, limits: PlatformLimits = UNBOUNDED_LIMITS): AppConfig => {
  const vars = env as Vars;
  const maxTextBytes = integer(
    vars,
    "MAX_TEXT_BYTES",
    Math.min(1_000_000, limits.maxTextBytes),
    1,
    limits.maxTextBytes,
  );
  const inlineTextBytes = integer(
    vars,
    "INLINE_TEXT_BYTES",
    Math.min(64_000, maxTextBytes, limits.maxInlineTextBytes),
    1,
    Math.min(maxTextBytes, limits.maxInlineTextBytes),
  );
  return {
    basePath: basePath(vars),
    maxFileBytes: integer(
      vars,
      "MAX_FILE_BYTES",
      Math.min(100_000_000, limits.maxFileBytes),
      1_000,
      limits.maxFileBytes,
    ),
    maxTextBytes,
    inlineTextBytes,
    itemTtlMs: integer(vars, "ITEM_TTL_SECONDS", 24 * 60 * 60, 0, 30 * 24 * 60 * 60) * 1000,
    maxItems: integer(vars, "MAX_ITEMS", 20, 1, 1_000),
    maxLiveConnections: integer(vars, "MAX_LIVE_CONNECTIONS", 100, 1, 10_000),
    sendsPerMinute: integer(vars, "SENDS_PER_MINUTE", 30, 1, 100_000),
    maxStorageBytes: integer(vars, "MAX_STORAGE_BYTES", 0, 0, Number.MAX_SAFE_INTEGER) || null,
    emptyNamespaceTtlMs:
      integer(vars, "EMPTY_NAMESPACE_TTL_SECONDS", 60 * 60, 60, 30 * 24 * 60 * 60) * 1000,
    adminKey: adminKey(vars),
    adminSessionHours: integer(vars, "ADMIN_SESSION_HOURS", 12, 1, 24 * 30),
    accessKey: accessKey(vars),
    accessSessionDays: integer(vars, "ACCESS_SESSION_DAYS", 30, 1, 365),
    publicShares: flag(vars, "PUBLIC_SHARES", true),
  };
};
