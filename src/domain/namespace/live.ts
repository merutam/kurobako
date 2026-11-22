// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A live viewer gets only what changed since the last snapshot it was sent.
import { type StoredItem, summaryItem } from "../model";

type Summary = ReturnType<typeof summaryItem>;

/** null when nothing changed. `snapshot` is stored for the next comparison. */
export const liveChange = (previous: string | undefined, items: StoredItem[]) => {
  const current = items.map(summaryItem);
  const snapshot = JSON.stringify(current);
  if (previous === snapshot) return null;
  const before = (previous ? JSON.parse(previous) : []) as Summary[];
  const old = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
  const next = new Set(current.map((item) => item.id));
  return {
    snapshot,
    upserts: current.filter((item) => old.get(item.id) !== JSON.stringify(item)),
    removed: before.filter((item) => !next.has(item.id)).map((item) => item.id),
    order: current.map((item) => item.id),
  };
};
