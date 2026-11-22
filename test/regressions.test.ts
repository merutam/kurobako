// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/application/deps";
import type { EditOptions, SendOptions } from "../src/application/items";
import { createItems } from "../src/application/items";
import { loadConfig } from "../src/config";
import { DomainError } from "../src/domain/errors";
import type { BlobStore } from "../src/domain/host";
import { HubCore } from "../src/domain/hub";
import { insidePath } from "../src/http/session";
import { startRouter } from "../src/infrastructure/bun/router";
import { startServer } from "../src/infrastructure/bun/server";
import { openDatabase, sqlOf } from "../src/infrastructure/bun/sqlite";
import { applyQueueChange } from "../src/protocol/queue";

const memoryStore = (): BlobStore => {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key, body) {
      objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { body: new Blob([bytes]).stream(), size: bytes.length } : null;
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
  };
};

const withServer = async (
  settings: Parameters<typeof loadConfig>[0],
  run: (base: string, store: BlobStore) => Promise<void>,
) => {
  const dir = mkdtempSync(join(tmpdir(), "kurobako-regression-"));
  const store = memoryStore();
  const app = await startServer({
    config: loadConfig(settings),
    dataDir: dir,
    blobs: store,
    port: 0,
    hostname: "127.0.0.1",
    logRequests: false,
  });
  try {
    await run(app.server.url.origin, store);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
};

test("login return paths reject browser-normalized external destinations", () => {
  for (const path of [
    "/\\evil.example",
    "//evil.example",
    "/\t/evil.example",
    "https://evil.example",
  ])
    expect(insidePath(path)).toBe("/");
  expect(insidePath("/notes?mode=all")).toBe("/notes?mode=all");
});

test("atomic storage reservations include concurrent uploads and bodies without Content-Length", async () => {
  await withServer({ MAX_STORAGE_BYTES: "10" }, async (base) => {
    const send = (name: string) =>
      fetch(`${base}/${name}/new`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("12345678"));
            c.close();
          },
        }),
      });
    const replies = await Promise.all([send("one"), send("two")]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 507]);
    const winner = replies[0]?.status === 201 ? "one" : "two";
    await fetch(`${base}/${winner}/1`, { method: "DELETE" });
    expect((await send("three")).status).toBe(201);
  });
});

test("storage failure before a claim preserves the last read", async () => {
  await withServer({}, async (base, store) => {
    const sent = await fetch(`${base}/limited/file.bin`, {
      method: "PUT",
      headers: { Reads: "1" },
      body: "contents",
    });
    expect(sent.status).toBe(201);
    const get = store.get;
    store.get = async () => {
      throw new Error("Temporary storage failure");
    };
    expect((await fetch(`${base}/limited/1`)).status).toBe(500);
    store.get = get;
    expect(await (await fetch(`${base}/limited/1`)).text()).toBe("contents");
    expect((await fetch(`${base}/limited/1`)).status).toBe(404);
  });
});

test("private statistics respect base paths and visitor authentication", async () => {
  const key = "private-key-at-least-sixteen";
  await withServer(
    { BASE_PATH: "/box", ACCESS_KEY: key, INTERNAL_STATS_KEY: "internal-only" },
    async (base) => {
      const router = startRouter({
        servers: [base],
        basePath: "/box",
        statsKey: "internal-only",
        port: 0,
        hostname: "127.0.0.1",
      });
      try {
        const url = `${router.url.origin}/box/stats.json`;
        expect((await fetch(url)).status).toBe(401);
        expect((await fetch(url, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(
          200,
        );
        expect((await fetch(`${base}/box/k/internal/stats`)).status).toBe(401);
        expect(
          (
            await fetch(`${base}/box/k/internal/stats`, {
              headers: { Authorization: `Bearer ${key}` },
            })
          ).status,
        ).toBe(401);
      } finally {
        await router.stop(true);
      }
    },
  );
});

test("hub reservations are idempotent and released with a committed report", async () => {
  const db = openDatabase(":memory:");
  const hub = new HubCore(loadConfig({ MAX_STORAGE_BYTES: "10" }), {
    sql: sqlOf(db),
    ensureAlarm: async () => {},
    setAlarm: async () => {},
    cleanUpNamespace: async () => {},
  });
  try {
    expect(await hub.reserveStorage("first", 8)).toBe(true);
    expect(await hub.reserveStorage("first", 8)).toBe(true);
    expect(await hub.reserveStorage("second", 8)).toBe(false);
    await hub.reportNamespace(
      { space: "plain", name: "one" },
      { items: 1, bytes: 8, connections: 0 },
      ["first"],
    );
    expect(await hub.reserveStorage("third", 2)).toBe(true);
  } finally {
    db.close();
  }
});

test("an ambiguous save rejection never deletes a potentially committed blob", async () => {
  let deleted = false;
  const store = memoryStore();
  store.delete = async () => {
    deleted = true;
  };
  const items = createItems({
    platform: { blobs: store },
    namespace: () => ({
      save: async () => {
        throw new Error("RPC failed after commit");
      },
    }),
  } as unknown as Pick<Deps, "platform" | "namespace">);
  await expect(
    items.saveObject(
      { space: "plain", name: "one" },
      { body: new Blob(["text"]).stream(), size: 4, head: new Uint8Array() },
      { kind: "text", preview: "text" },
      { burn: false } as SendOptions,
      () => {},
    ),
  ).rejects.toThrow("RPC failed after commit");
  expect(deleted).toBe(false);
});

test("queue deltas preserve order, reject gaps and ignore stale revisions", () => {
  const state = { items: [{ id: "a" }], revision: 1 };
  const change = { revision: 2, removed: [], upserts: [{ id: "b" }], order: ["b", "a"] };
  expect(applyQueueChange(state, change)).toEqual({
    items: [{ id: "b" }, { id: "a" }],
    revision: 2,
  });
  expect(applyQueueChange(state, { ...change, revision: 4 })).toBeNull();
  expect(applyQueueChange(state, { ...change, revision: 1 })).toBe(state);
  expect(applyQueueChange(state, { ...change, order: ["missing"] })).toBeNull();
});

test("a restarted namespace reconciles a reservation after a committed write loses its report", async () => {
  const { NamespaceCore } = await import("../src/domain/namespace");
  const hubDb = openDatabase(":memory:");
  const nsDb = openDatabase(":memory:");
  const settings = loadConfig({ MAX_STORAGE_BYTES: "10" });
  const hub = new HubCore(settings, {
    sql: sqlOf(hubDb),
    ensureAlarm: async () => {},
    setAlarm: async () => {},
    cleanUpNamespace: async () => {},
  });
  let alarm: number | null = null;
  const host = {
    hasStorage: () => true,
    sql: () => sqlOf(nsDb),
    deleteStorage: async () => {},
    setAlarm: async (time: number | null) => {
      alarm = time;
    },
    sockets: () => [],
    blobs: memoryStore(),
    hub: () => hub as unknown as ReturnType<Deps["hub"]>,
    later: (work: Promise<unknown>) => {
      void work;
    },
  };
  const report = hub.reportNamespace.bind(hub);
  try {
    hub.reportNamespace = async () => {
      throw new Error("Hub temporarily down");
    };
    const original = new NamespaceCore(settings, host);
    // Committed: the sender is told so, though the hub missed the report.
    const saved = await original.save(
      { space: "plain", name: "one" },
      { kind: "text", text: "12345678", size: 8 },
      false,
    );
    expect(saved.item.size).toBe(8);
    expect(alarm).not.toBeNull();
    expect((alarm ?? Infinity) - Date.now()).toBeLessThanOrEqual(30_000);
    expect(await hub.reserveStorage("too-big", 3)).toBe(false);
    hub.reportNamespace = report;
    const restarted = new NamespaceCore(settings, host);
    await restarted.alarm();
    expect((await restarted.list())[0]?.size).toBe(8);
    expect(await hub.reserveStorage("remaining", 2)).toBe(true);
  } finally {
    hubDb.close();
    nsDb.close();
  }
});

test("a known precommit refusal discards its unused uploaded blob", async () => {
  let deleted = false;
  const store = memoryStore();
  store.delete = async () => {
    deleted = true;
  };
  const items = createItems({
    platform: { blobs: store },
    namespace: () => ({
      save: async () => {
        throw new DomainError("view_changed", 409, "View changed.");
      },
    }),
  } as unknown as Pick<Deps, "platform" | "namespace">);
  await expect(
    items.saveObject(
      { space: "plain", name: "one" },
      { body: new Blob(["text"]).stream(), size: 4, head: new Uint8Array() },
      { kind: "text", preview: "text" },
      { burn: false } as SendOptions,
      () => {},
    ),
  ).rejects.toThrow("View changed.");
  expect(deleted).toBe(true);
});

test("a lost upload acknowledgement is recovered by its immutable object key", async () => {
  let uploadedKey = "";
  const store = memoryStore();
  const put = store.put;
  store.put = async (...args) => {
    uploadedKey = args[0];
    await put(...args);
  };
  const items = createItems({
    platform: { blobs: store },
    namespace: () => ({
      save: async () => {
        throw new Error("Acknowledgement lost");
      },
      findObject: async (key: string) =>
        key === uploadedKey
          ? {
              id: "committed",
              kind: "text",
              mime: "text/plain; charset=utf-8",
              preview: "text",
              object: key,
              size: 4,
              createdAt: new Date().toISOString(),
              expiresAt: null,
            }
          : null,
    }),
  } as unknown as Pick<Deps, "platform" | "namespace">);
  const saved = await items.saveObject(
    { space: "plain", name: "one" },
    { body: new Blob(["text"]).stream(), size: 4, head: new Uint8Array() },
    { kind: "text", preview: "text" },
    { burn: false } as SendOptions,
    () => {},
  );
  expect(saved.item.id).toBe("committed");
  expect(saved.existing).toBe(false);
});

test("rebuilding unchanged SDK assets does not retrigger the public directory watcher", async () => {
  const build = async () => {
    const child = Bun.spawn(["bun", "--no-env-file", "ops/build.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
  };
  await build();
  const sdk = new URL("../public/k.mjs", import.meta.url);
  const before = statSync(sdk, { bigint: true }).mtimeNs;
  await build();
  expect(statSync(sdk, { bigint: true }).mtimeNs).toBe(before);
});

/** A namespace core on in-memory databases, with hooks into its hub and timers. */
const coreHarness = async (settings: Parameters<typeof loadConfig>[0] = {}) => {
  const { NamespaceCore } = await import("../src/domain/namespace");
  const hubDb = openDatabase(":memory:");
  const nsDb = openDatabase(":memory:");
  const config = loadConfig(settings);
  const hub = new HubCore(config, {
    sql: sqlOf(hubDb),
    ensureAlarm: async () => {},
    setAlarm: async () => {},
    cleanUpNamespace: async () => {},
  });
  const blobs = memoryStore();
  const state = { alarm: null as number | null, deleted: false };
  const host = {
    hasStorage: () => !state.deleted,
    sql: () => sqlOf(nsDb),
    deleteStorage: async () => {
      state.deleted = true;
    },
    setAlarm: async (time: number | null) => {
      state.alarm = time;
    },
    sockets: () => [],
    blobs,
    hub: () => hub as unknown as ReturnType<Deps["hub"]>,
    later: (work: Promise<unknown>) => {
      void work.catch(() => {});
    },
  };
  return {
    core: new NamespaceCore(config, host),
    hub,
    blobs,
    state,
    close: () => {
      hubDb.close();
      nsDb.close();
    },
  };
};

const ref = { space: "plain", name: "one" } as const;
const write = { ref, verifier: null };

test("a send that arrives while cleanup waits for the hub is not deleted", async () => {
  const { core, hub, state, close } = await coreHarness();
  try {
    const first = await core.save(ref, { kind: "text", text: "first", size: 5 }, false);
    expect(await core.remove(first.item.id, undefined, write)).toBe(true);
    let release = () => {};
    const forget = hub.forgetNamespace.bind(hub);
    hub.forgetNamespace = async (target) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await forget(target);
    };
    const cleanup = core.alarm();
    await Bun.sleep(0);
    const saved = core.save(ref, { kind: "text", text: "second", size: 6 }, false);
    await Bun.sleep(0);
    release();
    await Promise.all([cleanup, saved]);
    expect(state.deleted).toBe(false);
    expect((await core.list()).map((item) => "text" in item && item.text)).toEqual(["second"]);
  } finally {
    close();
  }
});

test("a failed object delete is journaled and retried by the alarm", async () => {
  const { core, blobs, state, close } = await coreHarness();
  try {
    await blobs.put("objects/a", new Blob(["file"]).stream(), 4, "application/octet-stream");
    const saved = await core.save(
      ref,
      {
        kind: "file",
        mime: "application/octet-stream",
        filename: "a",
        object: "objects/a",
        size: 4,
      },
      false,
    );
    const remove = blobs.delete;
    blobs.delete = async () => {
      throw new Error("Storage temporarily down");
    };
    // The item is gone for its sender even though its object is still stored.
    expect(await core.remove(saved.item.id, undefined, write)).toBe(true);
    expect(await core.list()).toEqual([]);
    expect((state.alarm ?? Infinity) - Date.now()).toBeLessThanOrEqual(30_000);
    expect(await blobs.get("objects/a")).not.toBeNull();
    blobs.delete = remove;
    await core.alarm();
    expect(await blobs.get("objects/a")).toBeNull();
  } finally {
    close();
  }
});

test("a known refusal of an edit discards its unused uploaded blob", async () => {
  let deleted = false;
  const store = memoryStore();
  store.delete = async () => {
    deleted = true;
  };
  const items = createItems({
    platform: { blobs: store },
    namespace: () => ({
      replace: async () => {
        throw new DomainError("storage_full", 507, "Full.");
      },
    }),
  } as unknown as Pick<Deps, "platform" | "namespace">);
  await expect(
    items.replaceObject(
      ref,
      "1",
      new Date().toISOString(),
      { body: new Blob(["text"]).stream(), size: 4, head: new Uint8Array() },
      { kind: "text", preview: "text" },
      { visitor: undefined, verifier: null } as unknown as EditOptions,
      (work) => void work,
    ),
  ).rejects.toThrow("Full.");
  expect(deleted).toBe(true);
});

test("a restore refused by its namespace leaves no uploaded blobs", async () => {
  const { createBackups } = await import("../src/application/backups");
  const { writeArchive } = await import("../src/domain/archive");
  const store = memoryStore();
  const stored = new Set<string>();
  const put = store.put;
  store.put = async (key, ...rest) => {
    stored.add(key);
    await put(key, ...rest);
  };
  const remove = store.delete;
  store.delete = async (keys) => {
    for (const key of keys) stored.delete(key);
    await remove(keys);
  };
  const body = new TextEncoder().encode("x".repeat(100_000));
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      kurobako: "backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      namespaces: [
        {
          space: "plain",
          name: "one",
          items: [
            {
              id: "abcdef",
              kind: "file",
              createdAt: new Date().toISOString(),
              expiresAt: null,
              size: body.byteLength,
              path: "one/a.bin",
              filename: "a.bin",
              mime: "application/octet-stream",
            },
          ],
        },
      ],
    }),
  );
  const archive = writeArchive("tar", [
    {
      path: "manifest.json",
      size: manifest.byteLength,
      modified: new Date(),
      open: async () => new Blob([manifest]).stream(),
    },
    {
      path: "one/a.bin",
      size: body.byteLength,
      modified: new Date(),
      open: async () => new Blob([body]).stream(),
    },
  ]);
  const backups = createBackups({
    config: loadConfig({}),
    platform: { blobs: store },
    blobs: store,
    hub: () => ({ storedBytes: async () => 0 }),
    namespace: () => ({
      restore: async () => {
        throw new DomainError("write_denied", 403, "Write access denied.");
      },
    }),
  } as unknown as Parameters<typeof createBackups>[0]);
  const outcome = await backups
    .restore(archive, { space: "plain", name: "one" }, { maxItems: 10, verifier: null })
    .catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(DomainError);
  expect([...stored]).toEqual([]);
});

test("a manifest with a non-numeric size is refused", async () => {
  await withServer({}, async (base) => {
    const { writeArchive } = await import("../src/domain/archive");
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        kurobako: "backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        namespaces: [
          {
            space: "plain",
            name: "one",
            items: [
              { id: "1", kind: "text", createdAt: "", expiresAt: null, size: "9", path: "a" },
            ],
          },
        ],
      }),
    );
    const archive = writeArchive("tar", [
      {
        path: "manifest.json",
        size: manifest.byteLength,
        modified: new Date(),
        open: async () => new Blob([manifest]).stream(),
      },
    ]);
    const body = new Uint8Array(await new Response(archive).arrayBuffer());
    expect((await fetch(`${base}/one/import`, { method: "POST", body })).status).toBe(400);
  });
});

test("the hub's stored total follows reports, replacements and forgotten namespaces", async () => {
  const db = openDatabase(":memory:");
  try {
    const hub = new HubCore(loadConfig({ MAX_STORAGE_BYTES: "100" }), {
      sql: sqlOf(db),
      ensureAlarm: async () => {},
      setAlarm: async () => {},
      cleanUpNamespace: async () => {},
    });
    const counts = (bytes: number) => ({ items: 1, bytes, connections: 0 });
    await hub.reportNamespace({ space: "plain", name: "a" }, counts(30));
    await hub.reportNamespace({ space: "plain", name: "b" }, counts(20));
    await hub.reportNamespace({ space: "plain", name: "a" }, counts(10));
    expect(await hub.storedBytes()).toBe(30);
    expect(await hub.reserveStorage("one", 70)).toBe(true);
    expect(await hub.reserveStorage("two", 1)).toBe(false);
    await hub.reportNamespace({ space: "plain", name: "b" }, counts(20), ["one"]);
    await hub.forgetNamespace({ space: "plain", name: "a" });
    expect(await hub.storedBytes()).toBe(20);
    expect(await hub.reserveStorage("three", 80)).toBe(true);
    // Recounted from the tables on start.
    const restarted = new HubCore(loadConfig({ MAX_STORAGE_BYTES: "100" }), {
      sql: sqlOf(db),
      ensureAlarm: async () => {},
      setAlarm: async () => {},
      cleanUpNamespace: async () => {},
    });
    expect(await restarted.storedBytes()).toBe(20);
    expect(await restarted.reserveStorage("four", 1)).toBe(false);
  } finally {
    db.close();
  }
});

test("a deleted item's share link and view membership never reach a later item", async () => {
  const { core, hub, close } = await coreHarness();
  try {
    const first = await core.save(ref, { kind: "text", text: "secret", size: 6 }, false);
    const token = await hub.createShare(ref, first.item.id, null);
    expect(await hub.resolveShare(token)).not.toBeNull();
    await core.remove(first.item.id, undefined, write);
    await Bun.sleep(0);
    expect(await hub.resolveShare(token)).toBeNull();
  } finally {
    close();
  }
});

test("new items never take an ID a frozen view still lists", async () => {
  const { Queue } = await import("../src/domain/namespace/queue");
  const db = openDatabase(":memory:");
  try {
    const { QUEUE_SCHEMA } = await import("../src/domain/namespace/queue");
    db.run(QUEUE_SCHEMA);
    const queue = new Queue(() => sqlOf(db));
    const seen: string[] = [];
    const id = queue.freshId((candidate) => {
      seen.push(candidate);
      return seen.length < 3;
    });
    expect(seen).toHaveLength(3);
    expect(id).toBe(seen[2] as string);
  } finally {
    db.close();
  }
});
