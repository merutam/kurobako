// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { Hono } from "hono";
import { publicItem } from "../core/model";
import { renderGoneViewPage, renderSharedViewPage } from "../pages/shared-view";
import { createViews, parseViewRequest } from "../services/views";
import { type Api, type AppEnv, jsonError, readLimited, writeVerifier } from "./context";
import { namespaceOf, SPACES } from "./namespaces";

const MAX_VIEW_BODY = 100_000;

/** Writer-side rotation and the opaque, read-only view index. */
export const viewRoutes = (api: Api) => {
  const app = new Hono<AppEnv>();
  const { namespace, refuseWrite, config, visit, siteView, pageView } = api;
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

  // The same array shape as a namespace's /ls, with public share tokens as IDs.
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

  app.get("/v/:token{.+\\.json}", async (c) => {
    c.header("Cache-Control", "no-store");
    const view = await views.describe(c.req.param("token").slice(0, -5), visit(c));
    return view ? c.json(view) : jsonError(c, 404, "Shared view not found.");
  });
  app.get("/v/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    const view = await views.describe(c.req.param("token"), visit(c));
    // A browser gets a page saying so, as a gone share link does; .json stays JSON.
    if (!view) return c.html(renderGoneViewPage(siteView), 404);
    return pageView(
      c,
      renderSharedViewPage(siteView, view, `${config.basePath}/v/${c.req.param("token")}`),
    );
  });
  return app;
};
