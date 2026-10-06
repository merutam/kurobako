// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// A namespace: its page, queue, sends, access log and live updates. A plain
// namespace lives at /<name>, an encrypted one at /e/<id>, under the same
// short, fixed suffixes, so everything can be typed by hand.
import type { Next } from "hono";
import {
  type NamespaceRef,
  namespacePath,
  plainName,
  publicItem,
  type SpaceKind,
  type StoredItem,
  sealedName,
  summaryItem,
} from "../model";
import { renderLogPage } from "../pages";
import { type Api, type App, type AppContext, jsonError, TOO_MANY_SENDS } from "./context";
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

export const mountNamespaces = (
  app: App,
  api: Api,
  { uploadFile, uploadPlain, uploadSealed }: ReturnType<typeof createUploads>,
) => {
  const {
    namespace,
    visit,
    page,
    pageView,
    pages,
    build,
    assets,
    platformOf,
    sendAllowed,
    storageFull,
  } = api;
  /** A send's size, as it declares it (a text sent without one is small). */
  const declaredSize = (c: AppContext) => Number(c.req.header("content-length")) || 0;

  for (const space of SPACES) {
    const { prefix } = space;
    const { resolve, inNamespace } = namespaceOf(space);

    if (space.kind === "plain") {
      app.get(prefix, (c) =>
        // Nothing is stored until something is sent.
        resolve(c) ? pageView(c, pages.namespace) : jsonError(c, 404, "Invalid namespace."),
      );
    }

    app.get(
      `${prefix}/ls`,
      inNamespace(async (c, ref) => {
        const items = (await namespace(c, ref).list(visit(c))) as StoredItem[];
        // ?summary is what the page uses: long texts as previews.
        const shape = c.req.query("summary") === undefined ? publicItem : summaryItem;
        return c.json(items.map((item) => shape(item)));
      }),
    );

    app.post(
      `${prefix}/new`,
      inNamespace(async (c, ref) => {
        if (!(await sendAllowed(c))) return jsonError(c, 429, TOO_MANY_SENDS);
        const full = await storageFull(c, declaredSize(c));
        if (full) return full;
        return space.kind === "sealed" ? uploadSealed(c, ref) : uploadPlain(c, ref);
      }),
    );

    app.get(
      `${prefix}/log`,
      inNamespace(async (c, ref) =>
        page(
          c,
          build(
            renderLogPage(
              assets.layout,
              space.kind === "sealed" ? "encrypted namespace" : `/${ref.name}`,
              // The way back to an encrypted page needs the secret name; the
              // browser's history has it.
              space.kind === "sealed" ? null : namespacePath("", ref),
              `${namespacePath("", ref)}/log.json`,
              await namespace(c, ref).accessLog(visit(c)),
            ),
          ),
        ),
      ),
    );

    app.get(
      `${prefix}/log.json`,
      inNamespace(async (c, ref) => c.json(await namespace(c, ref).accessLog(visit(c)))),
    );

    // A WebSocket upgrade answer cannot carry headers, so this one starts by hand.
    app.get(`${prefix}/live`, async (c) => {
      const ref = resolve(c);
      if (!ref) return jsonError(c, 404, "Invalid namespace.");
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
        return jsonError(c, 426, "Expected a WebSocket upgrade.");
      }
      return platformOf(c).live(c, ref, visit(c));
    });
  }

  // `curl -T photo.jpg https://site/<ns>/` uploads to /<ns>/photo.jpg.
  // `curl -T photo.jpg https://site/<ns>` (no trailing slash) leaves the name
  // out: it comes from X-Filename then, or is just "file".
  app.put("/:namespace/:filename?", async (c) => {
    const name = plainName(c.req.param("namespace"));
    if (!name) return jsonError(c, 404, "Invalid namespace.");
    c.header("Cache-Control", "no-store");
    if (!(await sendAllowed(c))) return jsonError(c, 429, TOO_MANY_SENDS);
    const full = await storageFull(c, declaredSize(c));
    if (full) return full;
    const filename = c.req.param("filename") ?? c.req.header("x-filename");
    return uploadFile(c, { space: "plain", name }, decodeFilename(filename));
  });
};
