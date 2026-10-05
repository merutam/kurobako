// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Two ways to print logs. In a terminal, a short colored line per request and
// Bun's own, multi-line output for anything else, such as errors. For log
// collectors (journald, `podman logs`, …), one JSON object per line, as
// Cloudflare keeps them.

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

let jsonLines = false;

/** Makes console.* print one JSON line per call, with a `level` field: info and debug to stdout, warn and error to stderr. */
export const printJsonLines = () => {
  jsonLines = true;
  for (const [method, level] of Object.entries(LEVELS)) {
    const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
    Reflect.set(console, method, (...args: unknown[]) => stream.write(`${line(level, args)}\n`));
  }
};

export type RequestLog = { method: string; path: string; status: number; ms: number; ip: string };

const color = (code: number, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const DIM = 2;
const BOLD = 1;
/** Green for success, cyan for redirects, yellow for client errors, red for server errors. */
const statusColor = (status: number) =>
  status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32;

/** One request: `12:04:31 POST /ns/new 201 12ms 127.0.0.1`, or a JSON line. */
export const logRequestLine = (request: RequestLog) => {
  if (jsonLines) return console.info({ message: "request", ...request });
  const time = new Date().toTimeString().slice(0, 8);
  console.info(
    [
      color(DIM, time),
      color(BOLD, request.method),
      request.path,
      color(statusColor(request.status), String(request.status)),
      color(DIM, `${request.ms}ms`),
      color(DIM, request.ip),
    ].join(" "),
  );
};
