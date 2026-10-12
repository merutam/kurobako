// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// /i/<token>: one item, whose pages and links never reveal its namespace.
import { Hono } from "hono";
import { readLimitedItem, sharedItem } from "../core/model";
import { renderPage } from "../pages/components/layout";
import { SharedItemPage } from "../pages/shared-item";
import { createShares } from "../services/shares";
import type { createContents } from "./contents";
import { type Api, type AppContext, type AppEnv, jsonError } from "./context";

const SHARE_GONE = "This shared item is gone.";

export const shareRoutes = (api: Api, { serveItem }: ReturnType<typeof createContents>) => {
  const app = new Hono<AppEnv>();
  const { later, visit, countVisitor, platform, config, siteView } = api;
  const shares = createShares(api);

  const peekShared = async (c: AppContext, token: string) => {
    const { item, stale } = await shares.peek(token, visit(c));
    if (stale) later(c, shares.forget(token));
    return item;
  };

  // The page embeds the item, so it needs no second request.
  app.get("/i/:token/ls", async (c) => {
    c.header("Cache-Control", "no-store");
    const limit = c.req.query("limit");
    if (limit !== undefined && !/^[1-9]\d{0,5}$/.test(limit)) {
      return jsonError(c, 400, "limit must be a positive whole number.");
    }
    const token = c.req.param("token");
    const stored = await peekShared(c, token);
    return stored
      ? c.json([{ id: token, ...sharedItem(stored, c.req.query("summary") !== undefined) }])
      : jsonError(c, 404, SHARE_GONE);
  });

  app.get("/i/:token", async (c) => {
    const param = c.req.param("token");
    const asJson = param.endsWith(".json");
    const token = asJson ? param.slice(0, -".json".length) : param;
    // The item can expire or be read once.
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
      renderPage(
        <SharedItemPage
          site={siteView}
          item={stored}
          text={content}
          url={`${config.basePath}/i/${token}`}
        />,
      ),
      stored ? 200 : 404,
    );
  });

  for (const [suffix, inline] of [
    ["c", true],
    ["d", false],
  ] as const) {
    app.get(`/i/:token/${suffix}`, async (c) => {
      const share = await shares.resolve(c.req.param("token"));
      if (!share) return jsonError(c, 404, SHARE_GONE);
      // Named after the token, which the URL already shows, never the item's ID.
      const response = await serveItem(c, share.ref, share.itemId, inline, () => share.token);
      if (response) return response;
      later(c, shares.forget(share.token));
      return jsonError(c, 404, SHARE_GONE);
    });
  }
  return app;
};
