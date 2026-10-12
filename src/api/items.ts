// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// <item> is a position (1 is the newest), an ID or a name, tried in that
// order. Mounted after the namespace's fixed paths (ls, new, log, live) so they always win.
import { Hono } from "hono";
import { nameOf, publicItem, type StoredItem } from "../core/model";
import type { ItemRef } from "../core/namespace";
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
import type { createUploads } from "./uploads";

/** Names are cut much shorter; this only bounds what is read. */
const MAX_NAME_BYTES = 1_000;

const ITEM = ":item";
const toItemRef = (raw: string): ItemRef => (/^\d+$/.test(raw) ? Number(raw) : raw);
const itemRef = (c: AppContext): ItemRef => toItemRef(c.req.param("item") ?? "");

export const itemRoutes = (
  api: Api,
  { serveItem }: ReturnType<typeof createContents>,
  { editText }: ReturnType<typeof createUploads>,
) => {
  const app = new Hono<AppEnv>();
  const { namespace, hub, visit, platform, refuseSend, refuseWrite, storageFull, config } = api;
  const site = config.basePath;

  for (const space of SPACES) {
    const { prefix } = space;
    const { inNamespace } = namespaceOf(space);

    /** Before the contents route, which would take any name. Consumes nothing. */
    app.get(
      `${prefix}/:item{.+\\.json}`,
      inNamespace(async (c, ref, next) => {
        // An item really named data.json is itself, not data's details.
        const raw = c.req.param("item") ?? "";
        const same = (await namespace(ref).peek(raw, visit(c))) as StoredItem | null;
        if (same && (same.id === raw || nameOf(same) === raw)) {
          await next();
          return;
        }
        const selector = toItemRef(raw.slice(0, -".json".length));
        const found = (await namespace(ref).locate(selector, visit(c))) as {
          item: StoredItem;
          position: number;
        } | null;
        if (!found) return jsonError(c, 404, "Item not found.");
        // Making a share link is writing.
        const check = await namespace(ref).checkWrite(ref, await writeVerifier(c));
        if (check === "missing" || check === "wrong") {
          return c.json({ ...publicItem(found.item), position: found.position });
        }
        const token = await hub().createShare(ref, found.item.id, found.item.expiresAt);
        return c.json({
          ...publicItem(found.item),
          position: found.position,
          shareUrl: `${platform.origin(c)}${site}/i/${token}`,
        });
      }, "Item not found."),
    );

    // /c mirrors share links (/i/<token>/c), whose bare path is a page.
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

    /** Plain text, so `curl <ns>/1/s` prints just the link. */
    app.on(
      ["GET", "POST"],
      `${prefix}/${ITEM}/s`,
      inNamespace(async (c, ref) => {
        const refused = await refuseWrite(c, ref);
        if (refused) return refused;
        const item = (await namespace(ref).peek(itemRef(c), visit(c))) as StoredItem | null;
        if (!item) return jsonError(c, 404, "Item not found.");
        const token = await hub().createShare(ref, item.id, item.expiresAt);
        return c.text(`${platform.origin(c)}${site}/i/${token}\n`);
      }, "Item not found."),
    );

    /** Strong If-Match, so two editors never overwrite each other. */
    app.post(
      `${prefix}/${ITEM}/e`,
      inNamespace(async (c, ref) => {
        const tag = c.req.header("if-match")?.trim() ?? "";
        const matched = /^"([^"\\]+)"$/.exec(tag);
        if (!matched?.[1]) {
          return jsonError(c, 400, 'Editing needs If-Match: "<updatedAt-or-createdAt>".');
        }
        const refused = (await refuseSend(c)) ?? (await refuseWrite(c, ref));
        if (refused) return refused;
        const declared = Number(c.req.header("content-length")) || 0;
        const full = await storageFull(c, declared);
        if (full) return full;
        return editText(c, ref, itemRef(c), matched[1]);
      }, "Item not found."),
    );

    /** An encrypted item's name is in its sealed metadata, so it sends that instead. */
    app.post(
      `${prefix}/${ITEM}/n`,
      inNamespace(async (c, ref) => {
        const refused = (await refuseSend(c)) ?? (await refuseWrite(c, ref));
        if (refused) return refused;
        let change: { name: string } | { metadata: string };
        let expected: string | null = null;
        if (space.kind === "sealed") {
          const tag = c.req.header("if-match")?.trim() ?? "";
          const matched = /^"([^"\\]+)"$/.exec(tag);
          if (!matched?.[1]) {
            return jsonError(
              c,
              400,
              'Renaming an encrypted item needs If-Match: "<updatedAt-or-createdAt>".',
            );
          }
          expected = matched[1];
          change = { metadata: c.req.header("x-sealed-metadata") ?? "" };
        } else {
          const bytes = await readLimited(c, MAX_NAME_BYTES);
          if (!bytes) return jsonError(c, 413, `The limit is ${MAX_NAME_BYTES} bytes.`);
          change = { name: new TextDecoder().decode(bytes) };
        }
        const result = (await namespace(ref).rename(
          itemRef(c),
          change,
          expected,
          visit(c),
          await writeVerifier(c),
        )) as { item: StoredItem } | { error: string; conflict?: true } | null;
        if (!result) return jsonError(c, 404, "Item not found.");
        if ("error" in result) return jsonError(c, result.conflict ? 412 : 400, result.error);
        return c.json(publicItem(result.item));
      }, "Item not found."),
    );

    app.delete(
      `${prefix}/${ITEM}`,
      inNamespace(async (c, ref) => {
        const refused = await refuseWrite(c, ref);
        if (refused) return refused;
        const removed = await namespace(ref).remove(itemRef(c), visit(c), {
          ref,
          verifier: await writeVerifier(c),
        });
        return removed ? c.json({ ok: true }) : jsonError(c, 404, "Item not found.");
      }, "Item not found."),
    );
  }
  return app;
};
