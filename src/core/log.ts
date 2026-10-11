// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
// Logging, the same on every platform: each entry is one object with a
// `message`, which the platform prints as structured data.

/** Fields every Error has, or that only repeat the stack (Bun adds these). */
const COMMON_FIELDS = new Set([
  "name",
  "message",
  "stack",
  "cause",
  "line",
  "column",
  "originalLine",
  "originalColumn",
  "sourceURL",
]);
const MAX_CAUSES = 3;

/**
 * An error as plain data: its name and message, the fields its runtime adds
 * (such as an S3 error's `code` and `path`), its causes and its stack.
 */
export const errorDetails = (error: unknown, depth = 0): Record<string, unknown> => {
  if (!(error instanceof Error)) return { message: String(error) };
  const details: Record<string, unknown> = { name: error.name, message: error.message };
  for (const field of Object.getOwnPropertyNames(error)) {
    const value: unknown = Reflect.get(error, field);
    if (!COMMON_FIELDS.has(field) && typeof value !== "function") details[field] = value;
  }
  if (error.cause !== undefined) {
    details.cause = depth < MAX_CAUSES ? errorDetails(error.cause, depth + 1) : String(error.cause);
  }
  if (error.stack) details.stack = error.stack;
  return details;
};

/** Logs what failed, with the error under `error` so its fields keep their names. */
export const logError = (message: string, error: unknown, fields: Record<string, unknown> = {}) =>
  console.error({ message, ...fields, error: errorDetails(error) });
