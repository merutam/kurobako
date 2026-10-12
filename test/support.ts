// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

/** Which fields are set depends on its kind. */
export type Item = {
  id: string;
  kind: "text" | "image" | "file" | "sealed";
  size: number;
  createdAt: string;
  updatedAt?: string;
  expiresAt: string | null;
  burn?: true;
  text?: string;
  name?: string;
  preview?: string;
  filename?: string;
  mime?: string;
  metadata?: string;
};
/** These always have a name and a type. */
export type FileItem = Item & { filename: string; mime: string };
export type LiveMessage =
  | { type: "ready"; revision: number }
  | { type: "change"; revision: number; upserts: Item[]; removed: string[]; order: string[] }
  /** The receiver's page included. */
  | { type: "viewers"; count: number };
export type SharedItem = Omit<Item, "id">;

export const defined = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`Expected ${what}.`);
  return value;
};
