// SPDX-License-Identifier: AGPL-3.0-or-later

export type QueueState<T> = { items: T[]; revision: number };
export type QueueChange<T> = {
  revision: number;
  removed: string[];
  upserts: T[];
  order: string[];
};

/** Null means a gap: reconcile against /ls rather than guessing missing state. */
export const applyQueueChange = <T extends { id: string }>(
  state: QueueState<T>,
  change: QueueChange<T>,
): QueueState<T> | null => {
  if (change.revision <= state.revision) return state;
  if (change.revision !== state.revision + 1) return null;
  const byId = new Map(state.items.map((item) => [item.id, item]));
  for (const id of change.removed) byId.delete(id);
  for (const item of change.upserts) byId.set(item.id, item);
  const items: T[] = [];
  for (const id of change.order) {
    const item = byId.get(id);
    if (!item) return null;
    items.push(item);
  }
  return { items, revision: change.revision };
};
