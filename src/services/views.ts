// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Shared views: /v/<token>, a read-only list of some items of a namespace,
// each with its own share link, that the namespace's writer can rotate.
import { SHARE_TOKEN_PATTERN, type StoredItem, sharedItem } from "../core/model";
import type { ViewEntry } from "../core/namespace/views";
import type { AccessEvent } from "../core/visits";
import type { Deps } from "./deps";

/** What a writer sends to create a view (POST <ns>/views). */
export type ViewRequest = { viewId: string; entries: ViewEntry[]; previousToken: string | null };

/** A view request from its parsed JSON, or null when it is not one. */
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
  /**
   * The view a token opens, each item with a share link of its own; null
   * when the token is malformed or the view is gone. With `limit`, only its
   * first items; with `summary`, long texts as previews.
   */
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

  return { describe };
};
