// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

export type AppConfig = {
  maxFileBytes: number;
  maxTextBytes: number;
  itemTtlMs: number;
  maxItems: number;
  /** How long a namespace may stay empty before its storage is deleted. */
  emptyNamespaceTtlMs: number;
  /** Open live-update sockets allowed per namespace. */
  maxLiveConnections: number;
  /** Unset disables the admin dashboard at /a. */
  adminKey: string | null;
  adminSessionHours: number;
};

/** The largest sizes a platform can take; each platform sets its own. */
export type PlatformLimits = { maxFileBytes: number; maxTextBytes: number };

/** Long enough that guessing it, even without the login rate limit, is hopeless. */
export const ADMIN_KEY_MIN_LENGTH = 32;

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

/**
 * Reads the settings from environment variables (or a Worker's vars and
 * secrets). The defaults are the same everywhere; how far the sizes may go is
 * the platform's `limits`.
 */
export const loadConfig = (env: object, limits: PlatformLimits): AppConfig => {
  const vars = env as Vars;
  return {
    maxFileBytes: integer(
      vars,
      "MAX_FILE_BYTES",
      Math.min(100_000_000, limits.maxFileBytes),
      1_000,
      limits.maxFileBytes,
    ),
    maxTextBytes: integer(
      vars,
      "MAX_TEXT_BYTES",
      Math.min(256_000, limits.maxTextBytes),
      1,
      limits.maxTextBytes,
    ),
    itemTtlMs: integer(vars, "ITEM_TTL_SECONDS", 24 * 60 * 60, 0, 30 * 24 * 60 * 60) * 1000,
    maxItems: integer(vars, "MAX_ITEMS", 20, 1, 1_000),
    maxLiveConnections: integer(vars, "MAX_LIVE_CONNECTIONS", 100, 1, 10_000),
    emptyNamespaceTtlMs:
      integer(vars, "EMPTY_NAMESPACE_TTL_SECONDS", 60 * 60, 60, 30 * 24 * 60 * 60) * 1000,
    adminKey: adminKey(vars),
    adminSessionHours: integer(vars, "ADMIN_SESSION_HOURS", 12, 1, 24 * 30),
  };
};
