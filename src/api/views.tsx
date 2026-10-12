// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { Hono } from "hono";
import { publicItem } from "../core/model";
import { renderPage } from "../pages/components/layout";
import { GoneViewPage, SharedViewPage } from "../pages/shared-view";
import { createViews, parseViewRequest } from "../services/views";
import type { createContents } from "./contents";
import {
  type Api,
  type AppContext,
  type AppEnv,
  jsonError,
  readLimited,
  writeVerifier,
} from "./context";
import { namespaceOf, SPACES } from "./namespaces";

const MAX_VIEW_BODY = 100_000;
const ENTRY_GONE = "Not in this view.";

export const viewRoutes = (api: Api, { serveItem }: ReturnType<typeof createContents>) => {
  const app = new Hono<AppEnv>();
  const { namespace, refuseWrite, config, visit, siteView, pageView, platform } = api;
  const views = createViews(api);
  for (const space of SPACES) {
    const { inNamespace } = namespaceOf(space);
    app.get(
      `${space.prefix}/views`,
      inNamespace(async (c, ref) => {
        const refused = await refuseWrite(c, ref);
        if (refused) return refused;
        const status = await namespace(ref).viewsStatus(ref, await writeVerifier(c));
        return c.json({
          items: status.items.map(publicItem),
          views: status.views.map((view) => ({
            ...view,
            url: `${config.basePath}/v/${view.token}`,
          })),
        });
      }),
    );
    app.post(
      `${space.prefix}/views`,
      inNamespace(async (c, ref) => {
        const refused = await refuseWrite(c, ref);
        if (refused) return refused;
        const bytes = await readLimited(c, MAX_VIEW_BODY);
        if (!bytes) return jsonError(c, 413, "View index is too large.");
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return jsonError(c, 400, "Invalid view JSON.");
        }
        const request = parseViewRequest(body);
        if (!request) return jsonError(c, 400, "Invalid view entries.");
        const view = await namespace(ref).createView(
          ref,
          request.viewId,
          request.entries,
          request.previousToken,
          await writeVerifier(c),
        );
        return c.json({ ...view, url: `${config.basePath}/v/${view.token}` }, 201);
      }),
    );
  }

  // Same shape as /ls, so clients read both alike.
  app.get("/v/:token/ls", async (c) => {
    c.header("Cache-Control", "no-store");
    const limit = c.req.query("limit");
    if (limit !== undefined && !/^[1-9]\d{0,5}$/.test(limit)) {
      return jsonError(c, 400, "limit must be a positive whole number.");
    }
    const view = await views.describe(c.req.param("token"), visit(c), {
      summary: c.req.query("summary") !== undefined,
      limit: limit === undefined ? undefined : Number(limit),
    });
    if (!view) return jsonError(c, 404, "Shared view not found.");
    return c.json(
      view.entries.map(({ url, item, ...extra }) => ({
        id: url.slice(url.lastIndexOf("/") + 1),
        ...item,
        ...extra,
        ...(extra.envelope ? { viewId: view.viewId } : {}),
      })),
    );
  });

  // As in a namespace: /v/<token>/<item>, its /c, /d, .json and /s, <item>
  // being a position or the entry's own token.
  const entryOf = (c: AppContext) =>
    views.entry(
      c.req.param("token") ?? "",
      visit(c),
      (c.req.param("item") ?? "").replace(/\.json$/, ""),
    );

  app.get("/v/:token/:item{.+\\.json}", async (c) => {
    c.header("Cache-Control", "no-store");
    const found = await entryOf(c);
    if (!found) return jsonError(c, 404, ENTRY_GONE);
    return c.json({
      id: found.shareToken,
      ...found.item,
      position: found.position,
      shareUrl: `${platform.origin(c)}${config.basePath}/i/${found.shareToken}`,
      envelope: found.envelope,
      viewId: found.envelope ? found.viewId : undefined,
    });
  });

  for (const [suffix, inline] of [
    ["", true],
    ["/c", true],
    ["/d", false],
  ] as const) {
    app.get(`/v/:token/:item${suffix}`, async (c) => {
      const found = await entryOf(c);
      if (!found) return jsonError(c, 404, ENTRY_GONE);
      // Named after the entry's token, as on its share link.
      const response = await serveItem(c, found.ref, found.itemId, inline, () => found.shareToken);
      return response ?? jsonError(c, 404, ENTRY_GONE);
    });
  }

  app.on(["GET", "POST"], "/v/:token/:item/s", async (c) => {
    const found = await entryOf(c);
    if (!found) return jsonError(c, 404, ENTRY_GONE);
    return c.text(`${platform.origin(c)}${config.basePath}/i/${found.shareToken}\n`);
  });

  app.get("/v/:token{.+\\.json}", async (c) => {
    c.header("Cache-Control", "no-store");
    const view = await views.describe(c.req.param("token").slice(0, -5), visit(c));
    return view ? c.json(view) : jsonError(c, 404, "Shared view not found.");
  });
  app.get("/v/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    const view = await views.describe(c.req.param("token"), visit(c));
    // A browser gets a page, as a gone share link does.
    if (!view) return c.html(renderPage(<GoneViewPage site={siteView} />), 404);
    return pageView(
      c,
      renderPage(
        <SharedViewPage
          site={siteView}
          view={view}
          url={`${config.basePath}/v/${c.req.param("token")}`}
        />,
      ),
    );
  });
  return app;
};
