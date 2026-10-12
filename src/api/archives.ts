// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Backups: a namespace, or with the admin key the whole instance, as a zip or
// a tar, and back.
//
//   GET  <ns>/zip, <ns>/tar      the namespace (?since=<date>: items sent or changed since;
//                                ?max=<bytes>: in parts, see backupResponse)
//   POST <ns>/import             puts a backup of one namespace back into this one (PUT too)
//   GET  /a/zip, /a/tar          every namespace (admin)
//   POST /a/import               puts back every namespace in a backup (admin)
//
// What an archive holds, and how it is made and restored: services/backups.ts.
import { Hono } from "hono";
import type { ArchiveFormat } from "../core/archive";
import type { NamespaceRef } from "../core/model";
import { ADMIN_PATH } from "../core/routing";
import { BACKUP_FORMATS, type BackupPart, createBackups, decodeCursor } from "../services/backups";
import { type Api, type AppContext, type AppEnv, jsonError, writeVerifier } from "./context";
import { namespaceOf, SPACES } from "./namespaces";

const CONTENT_TYPES: Record<ArchiveFormat, string> = {
  zip: "application/zip",
  tar: "application/x-tar",
};
const day = (date: Date) => date.toISOString().slice(0, 10);

export const archiveRoutes = (api: Api) => {
  const app = new Hono<AppEnv>();
  const { config, hub, refuseSend, refuseWrite } = api;
  const backups = createBackups(api);

  /**
   * A backup of `refs` as a download, or one part of it: with ?max, its
   * X-Kurobako-Next header is the cursor for the rest (?after).
   */
  const backupResponse = async (
    c: AppContext,
    refs: NamespaceRef[],
    format: ArchiveFormat,
    part: BackupPart,
    filename: string,
  ) => {
    const made = await backups.backup(refs, format, part);
    if (made.empty) c.set("miss", true);
    // Parts are numbered, so `curl -OJ` never writes one over another.
    const name = part.max !== null ? `${filename}-part${made.part}` : filename;
    return new Response(made.archive, {
      headers: {
        "Content-Type": CONTENT_TYPES[format],
        "Content-Disposition": `attachment; filename="${name}.${format}"`,
        "Cache-Control": "no-store",
        ...(made.next ? { "X-Kurobako-Next": made.next } : {}),
      },
    });
  };

  /** ?max=<bytes>&after=<cursor>: one part of a backup (see backupResponse). */
  const partOf = (c: AppContext) => {
    const rawMax = c.req.query("max");
    const max = rawMax === undefined ? null : Number(rawMax);
    if (max !== null && (!Number.isSafeInteger(max) || max < 1)) {
      return jsonError(c, 400, "max must be a number of bytes, such as 90000000.");
    }
    const rawAfter = c.req.query("after");
    const after = rawAfter ? decodeCursor(rawAfter) : null;
    if (rawAfter && !after)
      return jsonError(c, 400, "after must be the X-Kurobako-Next of a part.");
    return { max, after };
  };

  /** ?since=<date or time>: only items sent or changed since then. */
  const sinceOf = (c: AppContext): number | null | Response => {
    const raw = c.req.query("since");
    if (!raw) return null;
    const time = Date.parse(raw);
    return Number.isNaN(time)
      ? jsonError(c, 400, "since must be a date, such as 2026-10-01 or 2026-10-01T12:00:00Z.")
      : time;
  };

  /**
   * Restores what an archive holds. With `into`, the archive must hold one
   * namespace, restored into that one (see services/backups.ts).
   */
  const importArchive = async (
    c: AppContext,
    into: NamespaceRef | null,
    maxItems: number | null,
  ) => {
    const body = c.req.raw.body;
    if (!body) return jsonError(c, 400, "Send a zip or tar made by a Kurobako backup.");
    const result = await backups.restore(body, into, {
      maxItems,
      verifier: await writeVerifier(c),
    });
    return "error" in result ? jsonError(c, result.status, result.error) : c.json(result);
  };

  // --- Routes -------------------------------------------------------------

  // The admin's, for the whole instance; /a/* already asks for the admin key.
  // First, or /:namespace/zip would take /a/zip.
  if (config.adminKey) {
    for (const format of BACKUP_FORMATS) {
      app.get(`${ADMIN_PATH}/${format}`, async (c) => {
        const since = sinceOf(c);
        if (since instanceof Response) return since;
        const part = partOf(c);
        if (part instanceof Response) return part;
        const refs = await hub().allNamespaces();
        return backupResponse(c, refs, format, { since, ...part }, `kurobako-${day(new Date())}`);
      });
    }
    app.on(["POST", "PUT"], `${ADMIN_PATH}/import`, (c) => importArchive(c, null, null));
  }

  for (const space of SPACES) {
    const { inNamespace } = namespaceOf(space);
    for (const format of BACKUP_FORMATS) {
      app.get(
        `${space.prefix}/${format}`,
        inNamespace(async (c, ref) => {
          const since = sinceOf(c);
          if (since instanceof Response) return since;
          const part = partOf(c);
          if (part instanceof Response) return part;
          const name = `${ref.name}-${day(new Date())}`;
          return backupResponse(c, [ref], format, { since, ...part }, name);
        }),
      );
    }
    // POST or PUT: `curl -T backup.zip <ns>/import` puts, and must not send a
    // file named "import" (registered before the namespace's own routes).
    app.on(
      ["POST", "PUT"],
      `${space.prefix}/import`,
      inNamespace(async (c, ref) => {
        const refused = (await refuseSend(c)) ?? (await refuseWrite(c, ref));
        if (refused) return refused;
        return importArchive(c, ref, config.maxItems);
      }),
    );
  }
  return app;
};
