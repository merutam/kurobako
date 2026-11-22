// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Backups and archive sizes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openSealedSpace } from "../../public/k.mjs";
import type { Manifest } from "../../src/application/backups";
import { archiveSize, entrySize, readArchive, writeArchive } from "../../src/domain/archive";
import { startServer } from "../../src/infrastructure/bun/server";
import { TEST_ADMIN_KEY } from "../admin-key";
import { defined, type Item } from "../support";
import { config, fresh, memoryStore, png, useDefaultServer } from "./harness";

useDefaultServer();

describe("backups", () => {
  const source = { dir: mkdtempSync(join(tmpdir(), "kurobako-backup-a-")), store: memoryStore() };
  const target = { dir: mkdtempSync(join(tmpdir(), "kurobako-backup-b-")), store: memoryStore() };
  const workDir = mkdtempSync(join(tmpdir(), "kurobako-backup-cli-"));
  let servers: Awaited<ReturnType<typeof startServer>>[] = [];
  const backupConfig = { ...config, maxItems: 10, adminKey: TEST_ADMIN_KEY, sendsPerMinute: 1000 };
  const admin = { authorization: `Bearer ${TEST_ADMIN_KEY}` };
  const from = (path: string, init?: RequestInit) =>
    fetch(`${servers[0]?.server.url.origin}${path}`, init);
  const to = (path: string, init?: RequestInit) =>
    fetch(`${servers[1]?.server.url.origin}${path}`, init);
  const text = (body: string, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "text/plain", ...headers },
    body,
  });
  const unpack = async (response: Response) => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    let manifest: Manifest | null = null;
    const files = new Map<string, Uint8Array>();
    const sizes = new Map<string, number>();
    for await (const entry of readArchive(new Blob([bytes]).stream(), (path) => sizes.get(path))) {
      const body = new Uint8Array(await new Response(entry.body).arrayBuffer());
      if (!manifest) {
        manifest = JSON.parse(new TextDecoder().decode(body)) as Manifest;
        for (const ns of manifest.namespaces)
          for (const item of ns.items) sizes.set(item.path, item.size);
      } else files.set(entry.path, body);
    }
    return { bytes, manifest: defined(manifest, "a manifest"), files };
  };
  const k = async (...args: string[]) => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "..", "public", "k.mjs"), ...args],
      {
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(error);
    return out;
  };

  beforeAll(async () => {
    servers = await Promise.all(
      [source, target].map(({ dir, store }) =>
        startServer({
          config: backupConfig,
          dataDir: dir,
          blobs: store.store,
          port: 0,
          hostname: "127.0.0.1",
          logRequests: false,
        }),
      ),
    );
  });
  afterAll(async () => {
    for (const running of servers) await running.stop();
    for (const dir of [source.dir, target.dir, workDir])
      rmSync(dir, { recursive: true, force: true });
  });

  test("a namespace goes out as zip or tar, and comes back the same", async () => {
    const ns = fresh();
    const long = "long text ".repeat(8_000); // above the inline threshold: kept in the store
    await from(`/${ns}/new`, text("first note"));
    await from(`/${ns}/photo.png`, { method: "PUT", body: png });
    await from(`/${ns}/new`, text(long));
    await from(`/${ns}/1/n`, { method: "POST", body: "the long one" });
    await from(`/${ns}/new`, text("gone after one read", { burn: "1" }));
    const listed = (await (await from(`/${ns}/ls`)).json()) as Item[];

    for (const format of ["zip", "tar"]) {
      const response = await from(`/${ns}/${format}`);
      expect(response.headers.get("content-disposition")).toContain(`${ns}-`);
      const { manifest, files } = await unpack(response);
      const items = defined(manifest.namespaces[0], "the namespace").items;
      // Oldest first; the burn-after-reading text is left out.
      expect(items.map((item) => item.kind)).toEqual(["text", "image", "text"]);
      expect(items.map((item) => item.path)).toEqual([
        `plain/${ns}/first note.txt`,
        `plain/${ns}/photo.png`,
        `plain/${ns}/the long one.txt`,
      ]);
      expect(new TextDecoder().decode(files.get(`plain/${ns}/the long one.txt`))).toBe(long);
      expect(files.get(`plain/${ns}/photo.png`)).toEqual(png);
    }

    // -O follows the URL; -OJ takes Content-Disposition. Options may follow the URL, as in curl.
    const archiveName = `${ns}-${new Date().toISOString().slice(0, 10)}.tar`;
    await k(`${servers[0]?.server.url.origin}/${ns}/tar`, "-OJ");
    expect(readdirSync(workDir)).toContain(archiveName);
    expect(existsSync(join(workDir, "tar"))).toBe(false);

    // A full backup with several namespaces needs its plain/<namespace> path.
    const local = "plain-extracted";
    const extracted = join(workDir, local);
    const offline = await unpack(await from(`/${ns}/tar`));
    mkdirSync(extracted);
    writeFileSync(join(extracted, "manifest.json"), JSON.stringify(offline.manifest));
    for (const [path, body] of offline.files) {
      const output = join(extracted, path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, body);
    }
    expect(await k(local)).toContain("first note");
    const offlineList = JSON.parse(await k(`${local}/ls`)) as Item[];
    expect(offlineList.map((item) => item.name ?? item.filename)).toEqual([
      "the long one",
      "photo.png",
      "first note",
    ]);
    expect(await k(`${local}/3`)).toBe("first note");
    expect(await k(`${local}/plain/${ns}/3/`)).toBe("first note");
    expect(JSON.parse(await k(`${local}/3.json`))).toMatchObject({
      kind: "text",
      name: "first note",
      text: "first note",
      position: 3,
    });
    expect(await k(join(local, `plain/${ns}/first note.txt`))).toBe("first note");

    offline.manifest.namespaces.push({ space: "plain", name: fresh(), items: [] });
    writeFileSync(join(extracted, "manifest.json"), JSON.stringify(offline.manifest));
    await expect(k(`${local}/ls`)).rejects.toThrow(/several plain namespaces/);
    expect(JSON.parse(await k(`${local}/plain/${ns}/ls`))).toHaveLength(3);

    // Into another namespace on another server: the same items, IDs and order.
    const backup = (await unpack(await from(`/${ns}/zip`))).bytes;
    const copy = fresh();
    const restored = await (await to(`/${copy}/import`, { method: "POST", body: backup })).json();
    expect(restored).toMatchObject({ restored: 3, skipped: 0, rejected: 0, namespaces: 1 });
    const copied = (await (await to(`/${copy}/ls`)).json()) as Item[];
    const kept = listed.filter((item) => !item.burn);
    expect(
      copied.map((item) => [item.id, item.kind, item.name, item.createdAt, item.updatedAt]),
    ).toEqual(kept.map((item) => [item.id, item.kind, item.name, item.createdAt, item.updatedAt]));
    expect(await (await to(`/${copy}/the long one`)).text()).toBe(long);

    // Again, as a tar sent with curl -T: nothing new.
    const tar = (await unpack(await from(`/${ns}/tar`))).bytes;
    const again = await (await to(`/${copy}/import`, { method: "PUT", body: tar })).json();
    expect(again).toMatchObject({ restored: 0, skipped: 3 });
    expect(await (await to(`/${copy}/ls`)).json()).toHaveLength(3);
  });

  test("a named source text keeps its extension in archives and imports", async () => {
    const ns = fresh();
    const contents = "export const answer = 42;\n";
    const sent = (await (
      await from(`/${ns}/new`, {
        ...text(contents),
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Text-Name": "answer.js" },
      })
    ).json()) as Item;
    expect(sent).toMatchObject({ kind: "text", name: "answer.js" });
    for (const format of ["zip", "tar"]) {
      const { manifest, files } = await unpack(await from(`/${ns}/${format}`));
      const path = `plain/${ns}/answer.js`;
      expect(manifest.namespaces[0]?.items[0]?.path).toBe(path);
      expect(new TextDecoder().decode(files.get(path))).toBe(contents);
    }
    const imported = await to(`/${ns}/import`, {
      method: "POST",
      body: await (await from(`/${ns}/tar`)).arrayBuffer(),
    });
    expect(imported.status).toBe(200);
    expect((await to(`/${ns}/${sent.id}/d`)).headers.get("content-disposition")).toContain(
      'filename="answer.js"',
    );
  });

  test("since=: only what was sent or changed after", async () => {
    const ns = fresh();
    await from(`/${ns}/new`, text("old and untouched"));
    const old = (await (await from(`/${ns}/new`, text("old name"))).json()) as Item;
    const editable = (await (await from(`/${ns}/new`, text("old contents"))).json()) as Item;
    const full = (await unpack(await from(`/${ns}/tar`))).bytes;
    const copy = fresh();
    expect(
      await (await to(`/${copy}/import`, { method: "POST", body: full })).json(),
    ).toMatchObject({
      restored: 3,
      skipped: 0,
    });
    await Bun.sleep(20);
    const cut = new Date().toISOString();
    const renamed = (await (
      await from(`/${ns}/${old.id}/n`, { method: "POST", body: "renamed after cut" })
    ).json()) as Item;
    const edited = (await (
      await from(`/${ns}/${editable.id}/e`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "if-match": JSON.stringify(editable.createdAt),
        },
        body: "edited after cut",
      })
    ).json()) as Item;
    await from(`/${ns}/new`, text("new"));
    const { bytes, manifest } = await unpack(await from(`/${ns}/tar?since=${cut}`));
    const items = defined(manifest.namespaces[0], "the namespace").items;
    expect(items.map((item) => item.name)).toEqual([
      "renamed after cut",
      "edited after cut",
      "new",
    ]);
    expect(items[0]?.updatedAt).toBe(renamed.updatedAt);
    expect(Date.parse(old.createdAt)).toBeLessThan(Date.parse(cut));
    expect(Date.parse(defined(renamed.updatedAt, "the rename time"))).toBeGreaterThanOrEqual(
      Date.parse(cut),
    );
    expect(
      await (await to(`/${copy}/import`, { method: "POST", body: bytes })).json(),
    ).toMatchObject({ restored: 3, skipped: 0 });
    const copied = (await (await to(`/${copy}/ls`)).json()) as Item[];
    expect(copied.find((item) => item.id === old.id)).toMatchObject({
      name: "renamed after cut",
      updatedAt: renamed.updatedAt,
    });
    expect(copied.find((item) => item.id === editable.id)).toMatchObject({
      name: "edited after cut",
      updatedAt: edited.updatedAt,
      text: "edited after cut",
    });
    expect(copied.map((item) => item.name)).toContain("new");
    expect((await from(`/${ns}/zip?since=yesterday-ish`)).status).toBe(400);
  });

  test("refuses what is not its own backup, and more items than a namespace holds", async () => {
    const ns = fresh();
    expect((await to(`/${ns}/import`, { method: "POST", body: "not an archive" })).status).toBe(
      400,
    );
    const crowded = fresh();
    for (let index = 0; index < 10; index += 1) await from(`/${crowded}/new`, text(`n${index}`));
    const bytes = (await unpack(await from(`/${crowded}/zip`))).bytes;
    const small = await startServer({
      config: { ...backupConfig, maxItems: 3 },
      dataDir: mkdtempSync(join(tmpdir(), "kurobako-backup-c-")),
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
    try {
      const refused = await fetch(`${small.server.url.origin}/${ns}/import`, {
        method: "POST",
        body: bytes,
      });
      expect(refused.status).toBe(413);
    } finally {
      await small.stop();
    }
  });

  test("encrypted namespaces back up still encrypted, and only restore into themselves", async () => {
    const box = servers[0]?.server.url.origin as string;
    const name = `backup ${crypto.randomUUID()}`;
    const link = `${box}/e#${encodeURIComponent(name)}`;
    await k("-d", "sealed note", `${link}/new`);
    const space = await openSealedSpace(name);

    await k("-o", "sealed.zip", `${link}/zip`);
    const { manifest, files } = await unpack(new Response(Bun.file(join(workDir, "sealed.zip"))));
    const [item] = defined(manifest.namespaces[0], "the namespace").items;
    expect(item?.kind).toBe("sealed");
    expect(item?.path).toBe(`sealed/${space.id}/${item?.id}.sealed`);
    // The server never had the name: nothing readable in the backup.
    expect(new TextDecoder().decode(files.get(item?.path ?? ""))).not.toContain("sealed note");

    const extracted = join(workDir, "sealed-extracted");
    mkdirSync(extracted);
    writeFileSync(join(extracted, "manifest.json"), JSON.stringify(manifest));
    for (const [path, body] of files) {
      const output = join(extracted, path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, body);
    }
    const sealedFile = join(extracted, defined(item?.path, "the sealed item path"));
    const secret = encodeURIComponent(name);
    expect(await k(`${sealedFile}#${secret}`)).toBe("sealed note");
    expect(JSON.parse(await k(`${extracted}#${secret}/ls`))).toMatchObject([
      { id: item?.id, kind: "text", name: "sealed note", text: "sealed note" },
    ]);
    expect(await k(`${extracted}#${secret}/1`)).toBe("sealed note");
    expect(await k(`${extracted}#${secret}/1/`)).toBe("sealed note");
    expect(await k(`${extracted}#${secret}/${item?.id}`)).toBe("sealed note");
    expect(JSON.parse(await k(`${extracted}#${secret}/1.json`))).toMatchObject({
      id: item?.id,
      kind: "text",
      text: "sealed note",
      position: 1,
    });
    await k("-O", `${extracted}#${secret}`);
    expect(readFileSync(join(workDir, "sealed note.txt"), "utf8")).toBe("sealed note");

    // Put back with k.mjs into the same namespace on the other server; readable again there.
    const elsewhere = `${servers[1]?.server.url.origin}/e#${encodeURIComponent(name)}`;
    expect(JSON.parse(await k("-T", "sealed.zip", `${elsewhere}/import`))).toMatchObject({
      restored: 1,
    });
    expect(await k(`${elsewhere}/1`)).toBe("sealed note");
    const other = `${servers[1]?.server.url.origin}/e#${encodeURIComponent(`${name} other`)}`;
    await expect(k("-T", "sealed.zip", `${other}/import`)).rejects.toThrow(/own namespace/);
  });

  test("restores past an item it refuses, and backups larger than any one send", async () => {
    // Small files and namespaces here: the whole backup is far above both.
    const strict = await startServer({
      config: { ...backupConfig, maxItems: 2, maxFileBytes: 1_000 },
      dataDir: mkdtempSync(join(tmpdir(), "kurobako-backup-e-")),
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
    try {
      const origin = strict.server.url.origin;
      const ns = fresh();
      await from(`/${ns}/small.bin`, { method: "PUT", body: new Uint8Array(500).fill(1) });
      await from(`/${ns}/large.bin`, { method: "PUT", body: new Uint8Array(5_000).fill(2) });
      await from(`/${ns}/after.bin`, { method: "PUT", body: new Uint8Array(500).fill(3) });
      for (const format of ["zip", "tar"]) {
        const backup = new Uint8Array(await (await from(`/${ns}/${format}`)).arrayBuffer());
        const into = fresh();
        // Three items for a namespace of two: refused whole.
        expect(
          (await fetch(`${origin}/${into}/import`, { method: "POST", body: backup })).status,
        ).toBe(413);
        const result = await (
          await fetch(`${origin}/k/a/import`, { method: "POST", headers: admin, body: backup })
        ).json();
        // The large file is refused; the one after it still comes through whole.
        expect(result).toMatchObject({ rejected: 1 });
        const after = await fetch(`${origin}/${ns}/after.bin`);
        expect(new Uint8Array(await after.arrayBuffer())).toEqual(new Uint8Array(500).fill(3));
      }

      // A whole instance far larger than MAX_ITEMS × MAX_FILE_BYTES.
      for (let index = 0; index < 4; index += 1) {
        const more = fresh();
        for (let file = 0; file < 2; file += 1) {
          await from(`/${more}/f${file}.bin`, {
            method: "PUT",
            body: new Uint8Array(900).fill(file),
          });
        }
      }
      const whole = new Uint8Array(
        await (await from("/k/a/zip", { headers: admin })).arrayBuffer(),
      );
      expect(whole.byteLength).toBeGreaterThan(2 * 1_000);
      const restored = await fetch(`${origin}/k/a/import`, {
        method: "POST",
        headers: admin,
        body: whole,
      });
      expect(restored.status).toBe(200);
    } finally {
      await strict.stop();
    }
  });

  test("in parts: each a whole backup, followed by its cursor until the last", async () => {
    const [first, second] = [fresh(), fresh()];
    for (let index = 0; index < 5; index += 1) {
      await from(`/${first}/f${index}.bin`, {
        method: "PUT",
        body: new Uint8Array(400).fill(index),
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await from(`/${second}/g${index}.bin`, {
        method: "PUT",
        body: new Uint8Array(400).fill(20 + index),
      });
    }
    const ours = new Set([first, second]);
    const parts: Uint8Array[] = [];
    const seen: string[] = [];
    let after = "";
    let deleted = false;
    for (let round = 0; round < 50; round += 1) {
      const response = await from(`/k/a/zip?max=1000${after ? `&after=${after}` : ""}`, {
        headers: admin,
      });
      expect(response.headers.get("content-disposition")).toContain(`-part${round + 1}.zip`);
      const next = response.headers.get("x-kurobako-next");
      const { bytes, manifest } = await unpack(response);
      expect(manifest.next).toBe(next ?? undefined);
      parts.push(bytes);
      const items = manifest.namespaces.flatMap((ns) => ns.items.map((item) => [ns.name, item]));
      // The whole part, headers and manifest included: what a restore's request carries.
      expect(items.length === 1 || bytes.byteLength <= 1000).toBe(true);
      for (const [ns, item] of items) {
        if (ours.has(ns as string)) seen.push(`${ns}/${(item as { id: string }).id}`);
      }
      // Deleting what a part already holds moves nothing out of the next ones.
      const exported = seen.find((path) => path.startsWith(`${first}/`));
      if (exported && !deleted) {
        deleted = true;
        await from(`/${exported}`, { method: "DELETE" });
      }
      if (!next) break;
      after = next;
    }
    expect(parts.length).toBeGreaterThan(2);
    expect(deleted).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((path) => path.startsWith(`${first}/`))).toHaveLength(5);
    expect(seen.filter((path) => path.startsWith(`${second}/`))).toHaveLength(2);

    const restore = await startServer({
      config: backupConfig,
      dataDir: mkdtempSync(join(tmpdir(), "kurobako-backup-f-")),
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
    try {
      const origin = restore.server.url.origin;
      // Last part first: the queue still comes out in order.
      for (const part of [...parts].reverse()) {
        const response = await fetch(`${origin}/k/a/import`, {
          method: "POST",
          headers: admin,
          body: part,
        });
        expect(response.status).toBe(200);
      }
      const restored = (await (await fetch(`${origin}/${first}/ls`)).json()) as Item[];
      expect(restored.map((item) => item.filename)).toEqual([
        "f4.bin",
        "f3.bin",
        "f2.bin",
        "f1.bin",
        "f0.bin",
      ]);
    } finally {
      await restore.stop();
    }
    expect((await from(`/${first}/zip?max=none`)).status).toBe(400);
    expect((await from(`/${first}/zip?max=10&after=garbage`)).status).toBe(400);
  });

  for (const format of ["zip", "tar"] as const) {
    test(`a ${format} part never outgrows max, however small its items`, async () => {
      const ns = fresh();
      for (let index = 0; index < 10; index += 1) await from(`/${ns}/new`, text(`small ${index}`));
      const max = 5_000;
      const seen: string[] = [];
      let after = "";
      for (let round = 0; round < 20; round += 1) {
        const response = await from(`/${ns}/${format}?max=${max}${after ? `&after=${after}` : ""}`);
        const { bytes, manifest } = await unpack(response);
        const items = manifest.namespaces.flatMap((entry) => entry.items);
        expect(bytes.byteLength).toBeLessThanOrEqual(max);
        expect(items.length).toBeGreaterThan(0);
        seen.push(...items.map((item) => item.id));
        const next = response.headers.get("x-kurobako-next");
        if (!next) break;
        after = next;
      }
      expect(seen).toHaveLength(10);
      expect(new Set(seen).size).toBe(10);
    });
  }

  test("items sent in the same millisecond keep their order, through restore and export", async () => {
    const ns = fresh();
    const at = "2026-10-01T12:00:00.000Z";
    const bodies = [new TextEncoder().encode("first"), new TextEncoder().encode("second")];
    // IDs in the opposite order to the queue's: only the queue's order may decide.
    const items = [
      { id: "zzzzzz", body: bodies[0] as Uint8Array, path: `plain/${ns}/first.txt`, name: "first" },
      {
        id: "aaaaaa",
        body: bodies[1] as Uint8Array,
        path: `plain/${ns}/second.txt`,
        name: "second",
      },
    ];
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        kurobako: "backup",
        version: 1,
        exportedAt: at,
        namespaces: [
          {
            space: "plain",
            name: ns,
            items: items.map(({ id, body, path, name }) => ({
              id,
              kind: "text",
              createdAt: at,
              expiresAt: null,
              size: body.byteLength,
              path,
              name,
            })),
          },
        ],
      }),
    );
    const archive = writeArchive("zip", [
      {
        path: "manifest.json",
        size: manifest.byteLength,
        modified: new Date(),
        open: async () => new Blob([manifest]).stream(),
      },
      ...items.map(({ body, path }) => ({
        path,
        size: body.byteLength,
        modified: new Date(at),
        open: async () => new Blob([body]).stream(),
      })),
    ]);
    const body = new Uint8Array(await new Response(archive).arrayBuffer());
    expect((await to(`/${ns}/import`, { method: "POST", body })).status).toBe(200);
    const listed = (await (await to(`/${ns}/ls`)).json()) as Item[];
    expect(listed.map((item) => item.name)).toEqual(["second", "first"]);
    const exported = await unpack(await to(`/${ns}/zip`));
    expect(exported.manifest.namespaces[0]?.items.map((item) => item.name)).toEqual([
      "first",
      "second",
    ]);
  });

  test("holds a namespace's manifest to what it can need", async () => {
    const huge = new TextEncoder().encode(
      JSON.stringify({
        kurobako: "backup",
        version: 1,
        padding: "x".repeat(200_000),
        namespaces: [],
      }),
    );
    const archive = writeArchive("tar", [
      {
        path: "manifest.json",
        size: huge.byteLength,
        modified: new Date(),
        open: async () => new Blob([huge]).stream(),
      },
    ]);
    const body = new Uint8Array(await new Response(archive).arrayBuffer());
    expect((await to(`/${fresh()}/import`, { method: "POST", body })).status).toBe(413);
  });

  test("the admin backs up and restores the whole instance", async () => {
    const plain = fresh();
    await from(`/${plain}/new`, text("everything"));
    const name = `whole ${crypto.randomUUID()}`;
    await k(
      "-d",
      "encrypted too",
      `${servers[0]?.server.url.origin}/e#${encodeURIComponent(name)}/new`,
    );

    expect((await from("/k/a/tar")).status).toBe(401);
    const backup = await from("/k/a/tar", { headers: admin });
    const { bytes, manifest } = await unpack(backup);
    const spaces = new Set(manifest.namespaces.map((ns) => ns.space));
    expect(spaces).toEqual(new Set(["plain", "sealed"]));

    const fresh2 = await startServer({
      config: backupConfig,
      dataDir: mkdtempSync(join(tmpdir(), "kurobako-backup-d-")),
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
    try {
      const origin = fresh2.server.url.origin;
      const result = await (
        await fetch(`${origin}/k/a/import`, { method: "POST", headers: admin, body: bytes })
      ).json();
      expect(result).toMatchObject({ namespaces: manifest.namespaces.length });
      expect(await (await fetch(`${origin}/${plain}/1`)).text()).toBe("everything");
      expect(await k(`${origin}/e#${encodeURIComponent(name)}/1`)).toBe("encrypted too");
    } finally {
      await fresh2.stop();
    }
  });
});

describe("archive sizes", () => {
  const at = new Date("2026-10-12T10:11:12Z");
  const entry = (path: string, size: number) => ({
    path,
    size,
    modified: at,
    open: async () => new Blob([new Uint8Array(size).fill(7)]).stream(),
  });
  const entries = [
    entry("manifest.json", 1234),
    entry("plain/ns/empty.txt", 0),
    entry("plain/ns/block.bin", 512),
    entry("plain/ns/çãé 日本語.txt", 77),
    entry(`plain/ns/${"x".repeat(150)}.bin`, 1000),
  ];

  for (const format of ["zip", "tar"] as const) {
    test(`${format}: archiveSize and entrySize are what writeArchive writes`, async () => {
      const written = (await new Response(writeArchive(format, entries)).arrayBuffer()).byteLength;
      expect(archiveSize(format, entries)).toBe(written);
      const [first, ...rest] = entries;
      const incremental = rest.reduce(
        (sum, next) => sum + entrySize(format, next),
        archiveSize(format, [defined(first, "a first entry")]),
      );
      expect(incremental).toBe(written);
    });
  }
});
