// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Shapes of the JSON the tests read, and small helpers shared by both suites.

/** An item as the JSON shows it; which fields are set depends on its kind. */
export type Item = {
  id: string;
  kind: "text" | "image" | "file" | "sealed";
  size: number;
  createdAt: string;
  updatedAt?: string;
  expiresAt: string | null;
  burn?: true;
  text?: string;
  /** A text's name. */
  name?: string;
  preview?: string;
  filename?: string;
  mime?: string;
  metadata?: string;
};
/** A file or image: these always have a name and a type. */
export type FileItem = Item & { filename: string; mime: string };
/** What a live connection receives. */
export type LiveMessage =
  | { type: "ready"; revision: number }
  | { type: "change"; revision: number; upserts: Item[]; removed: string[]; order: string[] }
  /** How many pages are open on the namespace, the receiver's included. */
  | { type: "viewers"; count: number };
/** A shared item: the same, minus its ID. */
export type SharedItem = Omit<Item, "id">;

/** The value, or a failed test saying what was missing. */
export const defined = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`Expected ${what}.`);
  return value;
};
