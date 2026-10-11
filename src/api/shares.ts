// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Shared items: /i/<token>. A token stands for one item. Its pages and links
// never mention the namespace; visits still show in that namespace's access log.
import {
  type NamespaceRef,
  readLimitedItem,
  SHARE_TOKEN_PATTERN,
  type StoredItem,
  sharedItem,
} from "../core/model";
import { renderSharedItemPage } from "../pages/shared-item";
import type { createContents } from "./contents";
import { type Api, type App, type AppContext, jsonError } from "./context";

/**
 * A token always points at the same item, so this instance remembers where
 * for a minute: reloading a shared page or loading its image skips the hub.
 * Whether the item still exists is always the namespace's answer.
 */
const SHARE_CACHE_MS = 60_000;
const SHARE_CACHE_MAX = 1_000;
const SHARE_GONE = "This shared item is gone.";

export const mountShares = (
  app: App,
  api: Api,
  { serveItem }: ReturnType<typeof createContents>,
) => {
  const { hub, namespace, later, visit, countVisitor, platform, config, siteView } = api;
  const shareCache = new Map<string, { expires: number; ref: NamespaceRef; itemId: string }>();

  const resolveShare = async (token: string) => {
    if (!SHARE_TOKEN_PATTERN.test(token)) return null;
    const cached = shareCache.get(token);
    if (cached && cached.expires > Date.now()) {
      return { token, ref: cached.ref, itemId: cached.itemId };
    }
    const share = (await hub().resolveShare(token)) as {
      ref: NamespaceRef;
      itemId: string;
    } | null;
    if (!share) return null;
    if (shareCache.size >= SHARE_CACHE_MAX) shareCache.clear();
    shareCache.set(token, {
      expires: Date.now() + SHARE_CACHE_MS,
      ref: share.ref,
      itemId: share.itemId,
    });
    return { token, ...share };
  };
  const forgetShare = (c: AppContext, token: string) => {
    shareCache.delete(token);
    later(c, hub().forgetShare(token));
  };

  /** The shared item, or null once it is gone. Reading it consumes nothing. */
  const peekShared = async (c: AppContext, token: string) => {
    const share = await resolveShare(token);
    if (!share) return null;
    const item = (await namespace(share.ref).peek(share.itemId, visit(c))) as StoredItem | null;
    if (!item) {
      forgetShare(c, token);
      return null;
    }
    return item;
  };

  // /i/<token> is the page, with the item embedded so it needs no request
  // for it; /i/<token>.json is the item alone.
  app.get("/i/:token", async (c) => {
    const param = c.req.param("token");
    const asJson = param.endsWith(".json");
    const token = asJson ? param.slice(0, -".json".length) : param;
    // Per request (the item can expire or be read once), so never cached.
    c.header("Cache-Control", "no-store");
    const stored = await peekShared(c, token);
    if (asJson) return stored ? c.json(sharedItem(stored)) : jsonError(c, 404, SHARE_GONE);
    countVisitor(c);
    let content: string | null = null;
    if (stored?.kind === "text" && !readLimitedItem(stored)) {
      if ("text" in stored) content = stored.text;
      else {
        const object = await platform.blobs.get(stored.object);
        if (object) content = await new Response(object.body).text();
      }
    }
    return c.html(
      renderSharedItemPage(siteView, stored, content, `${config.basePath}/i/${token}`),
      stored ? 200 : 404,
    );
  });

  for (const [suffix, inline] of [
    ["c", true],
    ["d", false],
  ] as const) {
    app.get(`/i/:token/${suffix}`, async (c) => {
      const share = await resolveShare(c.req.param("token"));
      if (!share) return jsonError(c, 404, SHARE_GONE);
      // Named after the token, which the URL already shows, never the item's ID.
      const response = await serveItem(c, share.ref, share.itemId, inline, () => share.token);
      if (response) return response;
      forgetShare(c, share.token);
      return jsonError(c, 404, SHARE_GONE);
    });
  }
};
