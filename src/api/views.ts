// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { publicItem, SHARE_TOKEN_PATTERN, type StoredItem, sharedItem } from "../model";
import type { ViewEntry } from "../namespace/views";
import {
  type Api,
  type App,
  type AppContext,
  jsonError,
  readLimited,
  writeVerifier,
} from "./context";
import { namespaceOf, SPACES } from "./namespaces";

const MAX_VIEW_BODY = 100_000;

/** Writer-side rotation and the opaque, read-only view index. */
export const mountViews = (app: App, api: Api) => {
  const { namespace, hub, refuseWrite, config, visit, pages, pageView } = api;
  for (const space of SPACES) {
    const { inNamespace } = namespaceOf(space);
    app.get(
      `${space.prefix}/views`,
      inNamespace(async (c, ref) => {
        const refused = await refuseWrite(c, ref);
        if (refused) return refused;
        const status = await namespace(c, ref).viewsStatus(ref, await writeVerifier(c));
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
          return jsonError(c, 400, "Invalid view entries.");
        }
        const view = await namespace(c, ref).createView(
          ref,
          body.viewId,
          body.entries as ViewEntry[],
          body.previousToken,
          await writeVerifier(c),
        );
        return c.json({ ...view, url: `${config.basePath}/v/${view.token}` }, 201);
      }),
    );
  }

  const describeView = async (c: AppContext, token: string) => {
    if (!SHARE_TOKEN_PATTERN.test(token)) return null;
    const ref = await hub(c).resolveView(token);
    if (!ref) return null;
    const view = await namespace(c, ref).viewContents(token, visit(c));
    if (!view) return null;
    const tokens = await hub(c).createShares(
      ref,
      view.entries.map(({ item }) => ({
        id: item.id,
        expiresAt: item.expiresAt,
      })),
    );
    const entries = view.entries.map(
      ({ item, envelope }: { item: StoredItem; envelope?: string }, index) => ({
        url: `${config.basePath}/i/${tokens[index]}`,
        item: sharedItem(item),
        ...(envelope ? { envelope } : {}),
      }),
    );
    return { viewId: view.viewId, active: view.active, createdAt: view.createdAt, entries };
  };

  app.get("/v/:token{.+\\.json}", async (c) => {
    c.header("Cache-Control", "no-store");
    const view = await describeView(c, c.req.param("token").slice(0, -5));
    return view ? c.json(view) : jsonError(c, 404, "Shared view not found.");
  });
  app.get("/v/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    const view = await describeView(c, c.req.param("token"));
    if (!view) return jsonError(c, 404, "Shared view not found.");
    return pageView(
      c,
      pages.view.replace('"%VIEW%"', () => JSON.stringify(view).replaceAll("<", "\\u003c")),
    );
  });
};
