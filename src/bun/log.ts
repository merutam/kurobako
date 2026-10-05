// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Bun prints objects across several lines, as for a person. Log collectors
// (journald, `podman logs`, …) want one JSON object per line, as Cloudflare
// keeps them.

import { errorDetails } from "../log";

const LEVELS = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" } as const;

/** Errors anywhere in an entry become plain data; values JSON cannot hold become text. */
const toJson = (_key: string, value: unknown) => {
  if (value instanceof Error) return errorDetails(value);
  if (typeof value === "bigint") return value.toString();
  return value;
};

/** Strings as they are; anything else as compact JSON when it can be. */
const asText = (value: unknown) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, toJson) ?? String(value);
  } catch {
    return Bun.inspect(value);
  }
};

const line = (level: string, args: unknown[]) => {
  const [first] = args;
  const text = () => args.map(asText).join(" ");
  const entry =
    args.length === 1 && first !== null && typeof first === "object" && !(first instanceof Error)
      ? { level, ...first }
      : { level, message: text() };
  try {
    return JSON.stringify(entry, toJson);
  } catch {
    // A cycle, for instance.
    return JSON.stringify({ level, message: text() });
  }
};

/** Makes console.* print one JSON line per call, with a `level` field: info and debug to stdout, warn and error to stderr. */
export const printJsonLines = () => {
  for (const [method, level] of Object.entries(LEVELS)) {
    const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
    Reflect.set(console, method, (...args: unknown[]) => stream.write(`${line(level, args)}\n`));
  }
};
