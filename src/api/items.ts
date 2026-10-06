// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// One item of a namespace: <ns>/<item>, where <item> is its position (digits,
// 1 being the newest), its ID or its name, resolved in that order. Mounted
// after the namespace's fixed paths (ls, new, log, live), which always win.
import { nameOf, publicItem, type StoredItem } from "../model";
import type { ItemRef } from "../namespace";
import type { createContents } from "./contents";
import {
  type Api,
  type App,
  type AppContext,
  jsonError,
  readLimited,
  TOO_MANY_SENDS,
} from "./context";
import { namespaceOf, SPACES } from "./namespaces";

/** Longest body a rename takes; names themselves are cut much shorter. */
const MAX_NAME_BYTES = 1_000;

const ITEM = ":item";
const toItemRef = (raw: string): ItemRef => (/^\d+$/.test(raw) ? Number(raw) : raw);
const itemRef = (c: AppContext): ItemRef => toItemRef(c.req.param("item") ?? "");

export const mountItems = (
  app: App,
  api: Api,
  { serveItem }: ReturnType<typeof createContents>,
) => {
  const { namespace, hub, visit, platformOf, sendAllowed, config } = api;
  const site = config.basePath;

  for (const space of SPACES) {
    const { prefix } = space;
    const { inNamespace } = namespaceOf(space);

    /**
     * One item as JSON: what the queue shows for it, its position, and a link
     * to share it. Reads nothing that would consume it. The share link is
     * made here if the item has none yet (one per item, so it never changes).
     * Registered before the contents, which would take any name.
     */
    app.get(
      `${prefix}/:item{.+\\.json}`,
      inNamespace(async (c, ref, next) => {
        // An item named exactly so (data.json) is read as itself.
        const raw = c.req.param("item") ?? "";
        const same = (await namespace(c, ref).peek(raw, visit(c))) as StoredItem | null;
        if (same && (same.id === raw || nameOf(same) === raw)) {
          await next();
          return;
        }
        const selector = toItemRef(raw.slice(0, -".json".length));
        const found = (await namespace(c, ref).locate(selector, visit(c))) as {
          item: StoredItem;
          position: number;
        } | null;
        if (!found) return jsonError(c, 404, "Item not found.");
        const token = await hub(c).createShare(ref, found.item.id, found.item.expiresAt);
        return c.json({
          ...publicItem(found.item),
          position: found.position,
          shareUrl: `${platformOf(c).origin(c)}${site}/i/${token}`,
        });
      }, "Item not found."),
    );

    // Reading contents consumes burn-after-reading items. /c is the same as
    // the bare item, as on a share link (/i/<token>/c), whose bare path is a page.
    for (const [suffix, inline] of [
      ["", true],
      ["/c", true],
      ["/d", false],
    ] as const) {
      app.get(
        `${prefix}/${ITEM}${suffix}`,
        inNamespace(async (c, ref) => {
          const response = await serveItem(c, ref, itemRef(c), inline);
          return response ?? jsonError(c, 404, "Item not found.");
        }, "Item not found."),
      );
    }

    /**
     * A link to this one item that does not reveal the namespace, as plain
     * text so `curl <ns>/1/s` prints just the link. GET or POST: the link is
     * the same every time.
     */
    app.on(
      ["GET", "POST"],
      `${prefix}/${ITEM}/s`,
      inNamespace(async (c, ref) => {
        const item = (await namespace(c, ref).peek(itemRef(c), visit(c))) as StoredItem | null;
        if (!item) return jsonError(c, 404, "Item not found.");
        const token = await hub(c).createShare(ref, item.id, item.expiresAt);
        return c.text(`${platformOf(c).origin(c)}${site}/i/${token}\n`);
      }, "Item not found."),
    );

    /**
     * Renames an item: the new name is the body (`curl -d 'name' <ns>/1/n`);
     * an empty one gives a text back its default. An encrypted item sends its
     * metadata sealed again instead, in X-Sealed-Metadata.
     */
    app.post(
      `${prefix}/${ITEM}/n`,
      inNamespace(async (c, ref) => {
        if (!(await sendAllowed(c))) return jsonError(c, 429, TOO_MANY_SENDS);
        let change: { name: string } | { metadata: string };
        if (space.kind === "sealed") {
          change = { metadata: c.req.header("x-sealed-metadata") ?? "" };
        } else {
          const bytes = await readLimited(c, MAX_NAME_BYTES);
          if (!bytes) return jsonError(c, 413, `The limit is ${MAX_NAME_BYTES} bytes.`);
          change = { name: new TextDecoder().decode(bytes) };
        }
        const result = (await namespace(c, ref).rename(itemRef(c), change, visit(c))) as
          | { item: StoredItem }
          | { error: string }
          | null;
        if (!result) return jsonError(c, 404, "Item not found.");
        if ("error" in result) return jsonError(c, 400, result.error);
        return c.json(publicItem(result.item));
      }, "Item not found."),
    );

    app.delete(
      `${prefix}/${ITEM}`,
      inNamespace(async (c, ref) => {
        const removed = await namespace(c, ref).remove(itemRef(c), visit(c));
        return removed ? c.json({ ok: true }) : jsonError(c, 404, "Item not found.");
      }, "Item not found."),
    );
  }
};
