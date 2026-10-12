// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { type PushConfig, vapidKeyProblem } from "./core/push";

export type AppConfig = {
  /** A path such as "/k" shares the domain with another site. */
  basePath: string;
  maxFileBytes: number;
  maxTextBytes: number;
  /** Larger texts go to the blob store. */
  inlineTextBytes: number;
  itemTtlMs: number;
  maxItems: number;
  /** Empty namespaces are deleted after this, so names do not hold storage forever. */
  emptyNamespaceTtlMs: number;
  maxLiveConnections: number;
  sendsPerMinute: number;
  missesPerMinute: number;
  /** null: no limit. */
  maxStorageBytes: number | null;
  /**
   * "limit" counts per network block (IPv4 /24, IPv6 /48): a script cannot spread over a
   * provider's many addresses.
   */
  automatedNetworks: AutomatedNetworks;
  /** Unset: no admin dashboard. */
  adminKey: string | null;
  adminSessionHours: number;
  /** Set: a private instance. */
  accessKey: string | null;
  accessSessionDays: number;
  publicShares: boolean;
  /** null when the VAPID keys are unset. */
  push: PushConfig | null;
  /** Each send is a push to every one of them at once, so this bounds the burst. */
  maxPushSubscriptions: number;
};

/** Each platform sets its own: Workers cap request bodies, a server does not. */
export type PlatformLimits = {
  maxFileBytes: number;
  maxTextBytes: number;
  maxInlineTextBytes: number;
};

const UNBOUNDED_LIMITS: PlatformLimits = {
  // Leave room for protocol overhead while staying within safe integers.
  maxFileBytes: Number.MAX_SAFE_INTEGER - 1_000_000,
  maxTextBytes: Number.MAX_SAFE_INTEGER - 1_000_000,
  maxInlineTextBytes: Number.MAX_SAFE_INTEGER - 1_000_000,
};

/** Hopeless to guess even without the login rate limit. */
export const ADMIN_KEY_MIN_LENGTH = 32;
/** Shorter: it is typed on phones, and failed logins are rate limited anyway. */
export const ACCESS_KEY_MIN_LENGTH = 16;

type Vars = Record<string, unknown>;

export type AutomatedNetworks = "allow" | "limit" | "block";
const AUTOMATED_NETWORKS: AutomatedNetworks[] = ["allow", "limit", "block"];

const automatedNetworks = (vars: Vars): AutomatedNetworks => {
  const raw = typeof vars.AUTOMATED_NETWORKS === "string" ? vars.AUTOMATED_NETWORKS.trim() : "";
  if (!raw) return "limit";
  const value = raw.toLowerCase() as AutomatedNetworks;
  if (!AUTOMATED_NETWORKS.includes(value)) {
    throw new Error(`AUTOMATED_NETWORKS must be one of ${AUTOMATED_NETWORKS.join(", ")}.`);
  }
  return value;
};

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

let pushProblemLogged = false;
const push = (vars: Vars): PushConfig | null => {
  // Accepts the line as ops/vapid.ts prints it (NAME=value), or quoted.
  const text = (name: string) =>
    typeof vars[name] === "string"
      ? (vars[name] as string)
          .trim()
          .replace(new RegExp(`^${name}=`), "")
          .replace(/^(["'])(.*)\1$/, "$2")
      : "";
  const publicKey = text("VAPID_PUBLIC_KEY");
  const privateKey = text("VAPID_PRIVATE_KEY");
  const subject = text("VAPID_SUBJECT") || "https://github.com/merutam/kurobako";
  if (!publicKey && !privateKey) return null;
  const problem =
    vapidKeyProblem(publicKey, privateKey) ??
    (/^(?:mailto:|https:\/\/)\S+$/.test(subject)
      ? null
      : "VAPID_SUBJECT must be a mailto: or https: URL.");
  // On Workers every request reads the settings: throwing here would take the whole site down.
  if (problem) {
    if (!pushProblemLogged) {
      console.error(`Notifications are off: ${problem} \`bun ops/vapid.ts\` makes a key pair.`);
      pushProblemLogged = true;
    }
    return null;
  }
  return { publicKey, privateKey, subject };
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
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  const path = trimmed ? `/${trimmed}` : "";
  if (path && !/^(?:\/[A-Za-z0-9._~-]+)+$/.test(path)) {
    throw new Error("BASE_PATH must be a path such as /k (letters, digits, . _ ~ -).");
  }
  return path;
};

/** Same defaults everywhere; `limits` is how far each platform lets sizes go. */
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
    sendsPerMinute: integer(vars, "SENDS_PER_MINUTE", 300, 1, 100_000),
    missesPerMinute: integer(vars, "MISSES_PER_MINUTE", 300, 1, 100_000),
    maxStorageBytes: integer(vars, "MAX_STORAGE_BYTES", 0, 0, Number.MAX_SAFE_INTEGER) || null,
    automatedNetworks: automatedNetworks(vars),
    emptyNamespaceTtlMs:
      integer(vars, "EMPTY_NAMESPACE_TTL_SECONDS", 60 * 60, 60, 30 * 24 * 60 * 60) * 1000,
    adminKey: adminKey(vars),
    adminSessionHours: integer(vars, "ADMIN_SESSION_HOURS", 12, 1, 24 * 30),
    accessKey: accessKey(vars),
    accessSessionDays: integer(vars, "ACCESS_SESSION_DAYS", 30, 1, 365),
    publicShares: flag(vars, "PUBLIC_SHARES", true),
    push: push(vars),
    maxPushSubscriptions: integer(vars, "MAX_PUSH_SUBSCRIPTIONS", 20, 1, 1_000),
  };
};
