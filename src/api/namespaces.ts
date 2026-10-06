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
import type { LockResult } from "../namespace";
import { renderLogPage } from "../pages";
import {
  type Api,
  type App,
  type AppContext,
  jsonError,
  sha256Hex,
  WRITE_KEY_HEADER,
} from "./context";
import { burnRequested, type createUploads, decodeFilename } from "./uploads";

/** A fresh write key for a plain namespace: 128 random bits in base64url (22 characters). */
const newWriteKey = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

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
    refuseSend,
    refuseWrite,
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
        const ns = namespace(c, ref);
        const [items, locked] = (await Promise.all([ns.list(visit(c)), ns.isLocked()])) as [
          StoredItem[],
          boolean,
        ];
        if (locked) c.header("Locked", "1");
        // Nothing here is what a name that does not exist answers too.
        if (!items.length) c.set("miss", true);
        // ?summary is what the page uses: long texts as previews.
        const shape = c.req.query("summary") === undefined ? publicItem : summaryItem;
        return c.json(items.map((item) => shape(item)));
      }),
    );

    app.post(
      `${prefix}/new`,
      inNamespace(async (c, ref) => {
        const refused =
          (await refuseSend(c)) ?? (await refuseWrite(c, ref, { burn: burnRequested(c) }));
        if (refused) return refused;
        const full = await storageFull(c, declaredSize(c));
        if (full) return full;
        return space.kind === "sealed" ? uploadSealed(c, ref) : uploadPlain(c, ref);
      }),
    );

    /**
     * Locks the namespace: from then on writing needs its key, in Write-Key,
     * while anyone may still read. A plain namespace locks only while empty,
     * and gets a key from the server (shown once), unless Write-Key brings
     * one; an encrypted one brings the key its client derived from the name.
     * Locked, the same request with the current key changes a plain
     * namespace's key.
     */
    app.post(
      `${prefix}/lock`,
      inNamespace(async (c, ref) => {
        c.header("Cache-Control", "no-store");
        const refused = await refuseSend(c);
        if (refused) return refused;
        const ns = namespace(c, ref);
        const given = c.req.header(WRITE_KEY_HEADER)?.trim() || null;
        const locked = (await ns.isLocked()) as boolean;
        if (locked && !given) {
          c.header("Locked", "1");
          return jsonError(
            c,
            401,
            "Already locked: changing its key needs the current one (Write-Key).",
          );
        }
        if (space.kind === "sealed" && !given) {
          return jsonError(
            c,
            400,
            "An encrypted namespace locks with the key its client derives (Write-Key).",
          );
        }
        const key =
          space.kind === "plain" && (locked || !given) ? newWriteKey() : (given as string);
        const result = (await ns.lock(
          ref,
          await sha256Hex(key),
          given && locked ? await sha256Hex(given) : null,
          space.kind === "plain",
        )) as LockResult;
        if (result === "not-empty") {
          return jsonError(c, 409, "Only an empty namespace can be locked.");
        }
        c.header("Locked", "1");
        if (result === "wrong") {
          c.set("miss", true);
          return jsonError(c, 403, "Wrong write key for this namespace.");
        }
        return c.json({ locked: true, ...(key !== given ? { writeKey: key } : {}) });
      }),
    );

    /** Opens a locked namespace to every writer again, given its key. */
    app.delete(
      `${prefix}/lock`,
      inNamespace(async (c, ref) => {
        const given = c.req.header(WRITE_KEY_HEADER)?.trim();
        const unlocked = given && (await namespace(c, ref).unlock(await sha256Hex(given)));
        if (unlocked) return c.json({ locked: false });
        c.set("miss", true);
        return jsonError(c, 403, "Wrong write key for this namespace, or it is not locked.");
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
      // The live queue shows what /ls does, so an empty one counts as a miss too.
      if (!((await namespace(c, ref).list()) as StoredItem[]).length) c.set("miss", true);
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
    const ref = { space: "plain", name } as const;
    const refused =
      (await refuseSend(c)) ?? (await refuseWrite(c, ref, { burn: burnRequested(c) }));
    if (refused) return refused;
    const full = await storageFull(c, declaredSize(c));
    if (full) return full;
    const filename = c.req.param("filename") ?? c.req.header("x-filename");
    return uploadFile(c, ref, decodeFilename(filename));
  });
};
