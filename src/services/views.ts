// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// /v/<token>: a read-only list the writer can rotate; each item has its own share link.
import {
  type NamespaceRef,
  objectName,
  SHARE_TOKEN_PATTERN,
  type StoredItem,
  sharedItem,
} from "../core/model";
import type { ViewEntry } from "../core/namespace/views";
import type { AccessEvent } from "../core/visits";
import type { Deps } from "./deps";

export type ViewRequest = { viewId: string; entries: ViewEntry[]; previousToken: string | null };

export const parseViewRequest = (body: unknown): ViewRequest | null => {
  if (
    !body ||
    typeof body !== "object" ||
    !("viewId" in body) ||
    typeof body.viewId !== "string" ||
    !("entries" in body) ||
    !Array.isArray(body.entries) ||
    !("previousToken" in body) ||
    (body.previousToken !== null && typeof body.previousToken !== "string") ||
    !body.entries.every(
      (entry: unknown) =>
        entry &&
        typeof entry === "object" &&
        "id" in entry &&
        typeof entry.id === "string" &&
        (!("envelope" in entry) || typeof entry.envelope === "string"),
    )
  ) {
    return null;
  }
  return {
    viewId: body.viewId,
    entries: body.entries as ViewEntry[],
    previousToken: body.previousToken as string | null,
  };
};

export const createViews = ({
  hub,
  namespace,
  config,
}: Pick<Deps, "hub" | "namespace" | "config">) => {
  const describe = async (
    token: string,
    visitor: AccessEvent,
    { summary = false, limit }: { summary?: boolean; limit?: number } = {},
  ) => {
    if (!SHARE_TOKEN_PATTERN.test(token)) return null;
    const ref = await hub().resolveView(token);
    if (!ref) return null;
    const view = await namespace(ref).viewContents(token, visitor);
    if (!view) return null;
    const selected = limit === undefined ? view.entries : view.entries.slice(0, limit);
    const tokens = await hub().createShares(
      ref,
      selected.map(({ item }) => ({
        id: item.id,
        expiresAt: item.expiresAt,
      })),
    );
    const entries = selected.map(
      ({ item, envelope }: { item: StoredItem; envelope?: string }, index) => ({
        url: `${config.basePath}/i/${tokens[index]}`,
        item: sharedItem(item, summary),
        ...(envelope ? { envelope } : {}),
      }),
    );
    return { viewId: view.viewId, active: view.active, createdAt: view.createdAt, entries };
  };

  /**
   * One entry, by position (1 is the first) or by its link's token, as a
   * namespace finds its items. Only its own share link is made.
   */
  const entry = async (token: string, visitor: AccessEvent, selector: string) => {
    if (!SHARE_TOKEN_PATTERN.test(token)) return null;
    const ref = await hub().resolveView(token);
    if (!ref) return null;
    const view = await namespace(ref).viewContents(token, visitor);
    if (!view) return null;
    const entries = view.entries as { item: StoredItem; envelope?: string }[];
    const index = /^[1-9]\d{0,5}$/.test(selector)
      ? Number(selector) - 1
      : await indexOfShare(entries, ref, selector);
    const found = entries[index];
    if (!found) return null;
    const [shareToken] = await hub().createShares(ref, [
      { id: found.item.id, expiresAt: found.item.expiresAt },
    ]);
    return {
      ref,
      itemId: found.item.id,
      shareToken: shareToken as string,
      position: index + 1,
      viewId: view.viewId,
      item: sharedItem(found.item),
      envelope: found.envelope,
    };
  };

  /** -1 unless the token is a share link of this view's own namespace and items. */
  const indexOfShare = async (
    entries: { item: StoredItem }[],
    ref: NamespaceRef,
    shareToken: string,
  ) => {
    if (!SHARE_TOKEN_PATTERN.test(shareToken)) return -1;
    const share = (await hub().resolveShare(shareToken)) as {
      ref: NamespaceRef;
      itemId: string;
    } | null;
    if (!share || objectName(share.ref) !== objectName(ref)) return -1;
    return entries.findIndex(({ item }) => item.id === share.itemId);
  };

  return { describe, entry };
};
