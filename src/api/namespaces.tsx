// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { Next } from "hono";
// A namespace: its page, queue, sends, access log and live updates. A plain
// namespace lives at /<name>, an encrypted one at /e/<id>, under the same
// short, fixed suffixes, so everything can be typed by hand.
import { Hono } from "hono";
import {
  type NamespaceRef,
  namespacePath,
  plainName,
  publicItem,
  type SpaceKind,
  type StoredItem,
  sealedName,
  summaryItem,
} from "../core/model";
import type { ListedItem } from "../pages/components/items";
import { renderPage } from "../pages/components/layout";
import { LogPage } from "../pages/log";
import { NamespacePage } from "../pages/namespace";
import { type Api, type AppContext, type AppEnv, jsonError, readLimited } from "./context";

/** A browser's push subscription is a few hundred bytes. */
const MAX_PUSH_BODY_BYTES = 4_000;

import { type createUploads, decodeFilename } from "./uploads";

export type Space = {
  kind: SpaceKind;
  prefix: string;
  validName: (raw: string) => string | null;
};

/** Encrypted routes go first: their literal /e prefix must win over /:namespace. */
export const SPACES: Space[] = [
  { kind: "sealed", prefix: "/e/:namespace", validName: sealedName },
  { kind: "plain", prefix: "/:namespace", validName: plainName },
];

type NamespaceHandler = (
  c: AppContext,
  ref: NamespaceRef,
  next: Next,
) => Response | Promise<Response | undefined>;

/** Finding the namespace a request names, in one space. */
export const namespaceOf = (space: Space) => {
  const resolve = (c: AppContext): NamespaceRef | null => {
    const name = space.validName(c.req.param("namespace") ?? "");
    return name ? { space: space.kind, name } : null;
  };
  /**
   * A namespace route's common start: the namespace, or 404 when the name is
   * invalid, and a response that is never cached.
   */
  const inNamespace =
    (handler: NamespaceHandler, notFound = "Invalid namespace.") =>
    async (c: AppContext, next: Next) => {
      const ref = resolve(c);
      if (!ref) return jsonError(c, 404, notFound);
      c.header("Cache-Control", "no-store");
      return handler(c, ref, next);
    };
  return { resolve, inNamespace };
};

export const namespaceRoutes = (
  api: Api,
  { uploadFile, uploadPlain, uploadSealed }: ReturnType<typeof createUploads>,
) => {
  const app = new Hono<AppEnv>();
  const {
    namespace,
    visit,
    page,
    pageView,
    platform,
    refuseSend,
    refuseWrite,
    storageFull,
    config,
    siteView,
  } = api;
  /** A send's size, as it declares it (a text sent without one is small). */
  const declaredSize = (c: AppContext) => Number(c.req.header("content-length")) || 0;

  for (const space of SPACES) {
    const { prefix } = space;
    const { resolve, inNamespace } = namespaceOf(space);

    if (space.kind === "plain") {
      app.get(prefix, async (c) => {
        const ref = resolve(c);
        if (!ref) return jsonError(c, 404, "Invalid namespace.");
        const { items, revision } = await namespace(ref).listState(visit(c));
        const shown = items.map((item) => summaryItem(item) as ListedItem & { id: string });
        return pageView(
          c,
          renderPage(
            <NamespacePage
              site={siteView}
              name={ref.name}
              queue={{ items: shown, revision }}
              config={config}
            />,
          ),
        );
      });
    }

    app.get(
      `${prefix}/ls`,
      inNamespace(async (c, ref) => {
        const { items, revision } = await namespace(ref).listState(visit(c));
        c.header("X-Queue-Revision", String(revision));
        // Nothing here is what a name that does not exist answers too.
        if (!items.length) c.set("miss", true);
        // ?summary is what the page uses: long texts as previews.
        const shape = c.req.query("summary") === undefined ? publicItem : summaryItem;
        // ?limit=n: only the n newest, for a client that wants just the top.
        const limit = c.req.query("limit");
        if (limit !== undefined && !/^[1-9]\d{0,5}$/.test(limit)) {
          return jsonError(c, 400, "limit must be a positive whole number.");
        }
        const shown = limit === undefined ? items : items.slice(0, Number(limit));
        return c.json(shown.map((item) => shape(item)));
      }),
    );

    app.post(
      `${prefix}/new`,
      inNamespace(async (c, ref) => {
        const refused = (await refuseSend(c)) ?? (await refuseWrite(c, ref));
        if (refused) return refused;
        const full = await storageFull(c, declaredSize(c));
        if (full) return full;
        return space.kind === "sealed" ? uploadSealed(c, ref) : uploadPlain(c, ref);
      }),
    );

    /**
     * Push notifications of this namespace's sends, for one device: the body
     * is its browser's PushSubscription (as JSON); with ?off, { endpoint }
     * stops them. Only POST: GET and DELETE on /push are an item named so.
     */
    app.post(
      `${prefix}/push`,
      inNamespace(async (c, ref) => {
        if (!config.push) return jsonError(c, 404, "This server sends no notifications.");
        const bytes = await readLimited(c, MAX_PUSH_BODY_BYTES);
        if (!bytes) return jsonError(c, 413, `The limit is ${MAX_PUSH_BODY_BYTES} bytes.`);
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return jsonError(c, 400, "Send the subscription as JSON.");
        }
        if (c.req.query("off") !== undefined) {
          const endpoint = (body as { endpoint?: unknown })?.endpoint;
          if (typeof endpoint !== "string") return jsonError(c, 400, "Send its endpoint.");
          await namespace(ref).unsubscribePush(endpoint);
          return c.json({ ok: true });
        }
        // Subscribing costs the server a message per send: it counts as one.
        const refused = await refuseSend(c);
        if (refused) return refused;
        const result = (await namespace(ref).subscribePush(body, visit(c))) as
          | { ok: true }
          | { error: string }
          | null;
        if (!result) {
          return jsonError(
            c,
            404,
            "Nothing is here yet: send something, then turn notifications on.",
          );
        }
        if ("error" in result) return jsonError(c, 400, result.error);
        return c.json(result, 201);
      }),
    );

    // Keep the retired route explicit so older clients get a clear answer.
    app.post(
      `${prefix}/lock`,
      inNamespace((c) => jsonError(c, 503, "Namespace locks are not part of this protocol.")),
    );

    /** The old lock lifecycle is not part of the current protocol. */
    app.delete(
      `${prefix}/lock`,
      inNamespace((c) => jsonError(c, 503, "Namespace locks are not part of this protocol.")),
    );

    app.get(
      `${prefix}/log`,
      inNamespace(async (c, ref) =>
        page(
          c,
          renderPage(
            <LogPage
              site={siteView}
              title={space.kind === "sealed" ? "encrypted namespace" : `/${ref.name}`}
              // The way back to an encrypted page needs the secret name; the
              // browser's history has it.
              backHref={space.kind === "sealed" ? null : namespacePath(config.basePath, ref)}
              jsonHref={`${namespacePath(config.basePath, ref)}/log.json`}
              entries={await namespace(ref).accessLog(visit(c))}
            />,
          ),
        ),
      ),
    );

    app.get(
      `${prefix}/log.json`,
      inNamespace(async (c, ref) => c.json(await namespace(ref).accessLog(visit(c)))),
    );

    // A WebSocket upgrade answer cannot carry headers, so this one starts by hand.
    app.get(`${prefix}/live`, async (c) => {
      const ref = resolve(c);
      if (!ref) return jsonError(c, 404, "Invalid namespace.");
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
        return jsonError(c, 426, "Expected a WebSocket upgrade.");
      }
      // An empty namespace still counts as a miss; live itself has no snapshot.
      if (!((await namespace(ref).list()) as StoredItem[]).length) c.set("miss", true);
      return platform.live(c, ref, visit(c));
    });
  }

  // `curl -T photo.jpg https://site/<ns>/` uploads to /<ns>/photo.jpg.
  // `curl -T photo.jpg https://site/<ns>` (no trailing slash) leaves the name
  // out: it comes from X-Filename then, or is just "file".
  app.put("/:namespace/:filename?", async (c) => {
    const name = plainName(c.req.param("namespace"));
    if (!name) return jsonError(c, 404, "Invalid namespace.");
    c.header("Cache-Control", "no-store");
    const ref = { space: "plain", name } as const;
    const refused = (await refuseSend(c)) ?? (await refuseWrite(c, ref));
    if (refused) return refused;
    const full = await storageFull(c, declaredSize(c));
    if (full) return full;
    const filename = c.req.param("filename") ?? c.req.header("x-filename");
    return uploadFile(c, ref, decodeFilename(filename));
  });
  return app;
};
