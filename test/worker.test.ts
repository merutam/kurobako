// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { CLOUDFLARE_LIMITS } from "../src/cloudflare/limits";
import { HUB_NAME } from "../src/cloudflare/objects";
import worker from "../src/cloudflare/worker";
import { loadConfig } from "../src/config";
import type { AccessLogEntry } from "../src/request-info";
import { TEST_ADMIN_KEY } from "./admin-key";
import { sharedTests } from "./shared";
import { defined, type FileItem, type Item, type LiveMessage } from "./support";

const ORIGIN = "https://kurobako.test";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Byte length of a test body, which browsers and curl send as Content-Length. */
const bodyLength = (body: RequestInit["body"]) =>
  typeof body === "string"
    ? new TextEncoder().encode(body).byteLength
    : body instanceof Uint8Array || body instanceof ArrayBuffer
      ? body.byteLength
      : null;

/** Calls the Worker and waits for its background work (stats, logs) to finish. */
const call = async (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  const length = bodyLength(init?.body);
  if (length !== null && !headers.has("content-length"))
    headers.set("content-length", String(length));
  // A different address per call unless the test picks one, so the per-IP
  // send limit only applies where a test means it to.
  if (!headers.has("cf-connecting-ip")) {
    const [a, b] = crypto.getRandomValues(new Uint8Array(2));
    headers.set("cf-connecting-ip", `198.18.${a}.${b}`);
  }
  init = { ...init, headers };
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  // Read the body first, as a browser would: some background work (deleting
  // a burn-after-reading file) waits for the response to be streamed out.
  if (response.webSocket) {
    await waitOnExecutionContext(ctx);
    return response;
  }
  const body = await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(response.status === 204 ? null : body, response);
};
const json = async <T = unknown>(path: string, init?: RequestInit) =>
  (await call(path, init)).json<T>();
const sendText = (namespace: string, text: string, headers: Record<string, string> = {}) =>
  call(`/${namespace}/new`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
    body: text,
  });

type PublicConfig = { namespace: { pattern: string; reserved: string[] } };

/** Storage is shared within this file, so every test uses fresh namespaces. */
const fresh = (prefix = "t") => `${prefix}${crypto.randomUUID().slice(0, 8)}`;
/** The hub's numbers, read directly: /stats.json caches them for a while. */
const stats = () => env.HUB.getByName(HUB_NAME).stats();
/** A namespace that exists (it had an item) and is empty again. */
const emptied = async (namespace: string) => {
  const item = await (await sendText(namespace, "gone soon")).json<Item>();
  await call(`/${namespace}/${item.id}`, { method: "DELETE" });
};

// Everything that holds on every platform, through this Worker.
sharedTests({
  describe,
  test,
  expect,
  call,
  storedFiles: async (prefix) =>
    (await env.BUCKET.list({ prefix })).objects.map((object) => object.key),
  config: loadConfig(env, CLOUDFLARE_LIMITS),
  origin: ORIGIN,
  adminKey: TEST_ADMIN_KEY,
});

// What only a Worker does: Durable Object alarms and storage, R2 metadata,
// Workers Static Assets, hibernating WebSockets and its own configuration.

describe("plain namespaces", () => {
  test("rejects bodies over the limit and files without a length", async () => {
    const { maxTextBytes, maxFileBytes } = loadConfig(env, CLOUDFLARE_LIMITS);
    expect((await sendText(fresh(), "x".repeat(maxTextBytes + 1))).status).toBe(413);
    const tooBig = await call(`/${fresh()}/new`, {
      method: "POST",
      headers: { "content-length": String(maxFileBytes + 1) },
      body: png,
    });
    expect(tooBig.status).toBe(413);

    const ctx = createExecutionContext();
    const unknownLength = await worker.fetch(
      new Request(`${ORIGIN}/${fresh()}/new`, {
        method: "POST",
        body: new Blob([png]).stream(),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(unknownLength.status).toBe(411);
  });

  test("expires items through the namespace alarm", async () => {
    const ns = fresh();
    await json(`/${ns}/new`, { method: "POST", body: png });
    const stub = env.NAMESPACES.getByName(`plain:${ns}`);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE items SET expires_at = ?", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await json<Item[]>(`/${ns}/ls`)).toEqual([]);
    expect((await env.BUCKET.list({ prefix: `plain/${ns}/` })).objects).toHaveLength(0);
  });
});

describe("empty namespace cleanup", () => {
  const auth = { authorization: `Bearer ${TEST_ADMIN_KEY}` };
  const listed = async (ns: string) =>
    (await json<{ total: number }>(`/a/namespaces?q=${ns}`, { headers: auth })).total;
  const storedRows = (ns: string) =>
    runInDurableObject(
      env.NAMESPACES.getByName(`plain:${ns}`),
      (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray().length,
    );

  test("opening, listing or watching a namespace stores nothing, as with bots", async () => {
    const ns = fresh("bot");
    await call(`/${ns}`, { headers: { "cf-connecting-ip": "192.0.2.50" } });
    await call(`/${ns}/ls`, { headers: { "cf-connecting-ip": "192.0.2.50" } });
    expect(await json<AccessLogEntry[]>(`/${ns}/log.json`)).toEqual([]);
    const live = await call(`/${ns}/live`, { headers: { upgrade: "websocket" } });
    const socket = defined(live.webSocket, "a WebSocket");
    socket.accept();
    socket.close(1000);

    expect(await listed(ns)).toBe(0);
    expect(await storedRows(ns)).toBe(0);
  });

  test("deletes a namespace an hour after its last item", async () => {
    const ns = fresh("empty");
    await emptied(ns);
    expect(await listed(ns)).toBe(1);

    const stub = env.NAMESPACES.getByName(`plain:${ns}`);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await listed(ns)).toBe(0);
    expect(await storedRows(ns)).toBe(0);
    // It works again afterwards, from scratch.
    expect(await json<Item[]>(`/${ns}/ls`)).toEqual([]);
    expect((await sendText(ns, "back")).status).toBe(201);
  });

  test("keeps namespaces with items, and waits again once the last one expires", async () => {
    const ns = fresh("kept");
    await sendText(ns, "still here");
    const stub = env.NAMESPACES.getByName(`plain:${ns}`);
    // The alarm is the item's expiry, which has not come yet.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await json<Item[]>(`/${ns}/ls`)).toHaveLength(1);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE items SET expires_at = ?", Date.now() - 1);
    });
    // Expiry empties it; the cleanup is only scheduled, not done.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await listed(ns)).toBe(1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await listed(ns)).toBe(0);
  });

  test("the hub's sweep cleans up empty namespaces that lost their alarm", async () => {
    const ns = fresh("old");
    await emptied(ns);
    const stub = env.NAMESPACES.getByName(`plain:${ns}`);
    // Like namespaces created before cleanups existed: no alarm, empty for long.
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    const hub = env.HUB.getByName(HUB_NAME);
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec("UPDATE namespaces SET updated_at = 0 WHERE name = ?", ns);
    });

    expect(await runDurableObjectAlarm(hub)).toBe(true);
    expect(await listed(ns)).toBe(0);
    expect(await storedRows(ns)).toBe(0);
  });

  test("waits while someone has the namespace open", async () => {
    const ns = fresh("open");
    await emptied(ns);
    const response = await call(`/${ns}/live`, { headers: { upgrade: "websocket" } });
    const socket = defined(response.webSocket, "a WebSocket");
    socket.accept();
    const stub = env.NAMESPACES.getByName(`plain:${ns}`);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await listed(ns)).toBe(1);
    socket.close(1000);
  });
});

describe("access logs", () => {
  test("keeps entries as long as the namespace exists, with no time limit", async () => {
    const ns = fresh("log");
    await sendText(ns, "here", { "cf-connecting-ip": "192.0.2.77" });
    await runInDurableObject(env.NAMESPACES.getByName(`plain:${ns}`), (_instance, state) => {
      state.storage.sql.exec("UPDATE access_log SET last_seen = 0");
    });
    await call(`/${ns}/ls`, { headers: { "cf-connecting-ip": "192.0.2.78" } });

    const ips = (await json<AccessLogEntry[]>(`/${ns}/log.json`)).map((entry) => entry.ip);
    expect(ips).toEqual(expect.arrayContaining(["192.0.2.77", "192.0.2.78"]));
    const page = await (await call(`/${ns}/log`)).text();
    expect(page).not.toMatch(/last \d+ day/);
  });
});

describe("files in R2", () => {
  test("stores each file with its type and streams it back", async () => {
    const ns = fresh();
    const image = await json<FileItem>(`/${ns}/new`, { method: "POST", body: png });
    const [stored] = (await env.BUCKET.list({ prefix: `plain/${ns}/`, include: ["httpMetadata"] }))
      .objects;
    const object = defined(stored, "the stored file");
    expect(object?.httpMetadata?.contentType).toBe("image/png");
    const download = await call(image.downloadUrl);
    expect(download.headers.get("content-length")).toBe(String(png.byteLength));
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);
  });
});

describe("hub housekeeping", () => {
  test("prunes visitors after a day and activity after a week, on its alarm", async () => {
    const hub = env.HUB.getByName(HUB_NAME);
    await call("/", { headers: { "cf-connecting-ip": "198.51.100.250" } });
    await runInDurableObject(hub, (_instance, state) => {
      const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO visitors VALUES ('192.0.2.250', 'BR', ?)",
        old,
      );
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO activity VALUES ('2000-01-01', 'sentText', 5)",
      );
    });
    expect(await runDurableObjectAlarm(hub)).toBe(true);
    const left = await runInDurableObject(hub, (_instance, state) => ({
      old: state.storage.sql.exec("SELECT 1 FROM visitors WHERE ip = '192.0.2.250'").toArray()
        .length,
      recent: state.storage.sql.exec("SELECT 1 FROM visitors WHERE ip = '198.51.100.250'").toArray()
        .length,
      ancient: state.storage.sql.exec("SELECT 1 FROM activity WHERE day = '2000-01-01'").toArray()
        .length,
    }));
    expect(left).toEqual({ old: 0, recent: 1, ancient: 0 });
  });
});

describe("live updates", () => {
  test("push the queue over a WebSocket on connect and after each change", async () => {
    const ns = fresh();
    const response = await call(`/${ns}/live`, { headers: { upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = defined(response.webSocket, "a WebSocket");
    const messages: LiveMessage[] = [];
    let notify = () => {};
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(event.data as string));
      notify();
    });
    socket.accept();
    const nextMessage = async (count: number) => {
      while (messages.length < count) await new Promise<void>((resolve) => (notify = resolve));
      return messages[count - 1];
    };

    expect(await nextMessage(1)).toEqual({ type: "items", items: [] });
    await sendText(ns, "live");
    expect((await nextMessage(2))?.items).toMatchObject([{ kind: "text", text: "live" }]);

    const connected = (await stats()).liveConnections;
    socket.close(1000);
    let after = connected;
    for (let attempt = 0; attempt < 50 && after === connected; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      after = (await stats()).liveConnections;
    }
    expect(after).toBe(connected - 1);
  });

  test("a device waiting on a namespace that does not exist yet gets its first item", async () => {
    const ns = fresh("wait");
    const response = await call(`/${ns}/live`, { headers: { upgrade: "websocket" } });
    const socket = defined(response.webSocket, "a WebSocket");
    const messages: LiveMessage[] = [];
    let notify = () => {};
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(event.data as string));
      notify();
    });
    socket.accept();
    while (messages.length < 1) await new Promise<void>((resolve) => (notify = resolve));
    expect(messages[0]).toEqual({ type: "items", items: [] });

    await sendText(ns, "first one");
    while (messages.length < 2) await new Promise<void>((resolve) => (notify = resolve));
    expect(messages[1]?.items).toMatchObject([{ kind: "text", text: "first one" }]);
    socket.close(1000);
  });
});

describe("site", () => {
  test("leaves scripts and styles to Workers Static Assets", async () => {
    // In production these never reach the Worker (run_worker_first); the
    // Worker itself has no route for them.
    expect((await call("/namespace.js")).status).toBe(404);
    for (const path of ["namespace.js", "styles.css", "vendor/uqr.js"]) {
      expect((await env.ASSETS.fetch(`https://assets.invalid/${path}`)).status).toBe(200);
    }
  });

  test("serves the encryption spec, and keeps its name from becoming a namespace", async () => {
    const page = await (await call("/protocol")).text();
    // The spec must match the code browsers run.
    const sealed = await (await env.ASSETS.fetch("https://assets.invalid/k.mjs")).text();
    const salt = sealed.match(/PROTOCOL_SALT = "([^"]+)"/)?.[1];
    const iterations = Number(
      sealed.match(/PBKDF2_ITERATIONS = ([\d_]+)/)?.[1]?.replaceAll("_", ""),
    );
    expect(page).toContain(defined(salt, "the salt in k.mjs"));
    expect(page).toContain(iterations.toLocaleString("en-US"));
    expect(page).not.toContain("%APP_VERSION%");
    expect((await call("/protocol/ls")).status).toBe(404);
    expect((await json<PublicConfig>("/config.json")).namespace.reserved).toContain("protocol");
  });

  test("public stats count activity without naming namespaces or visitors", async () => {
    const before = await stats();
    const ns = fresh("stats");
    // Visitors are counted on page views, not on API calls.
    await call(`/${ns}`, {
      headers: { "cf-connecting-ip": "203.0.113.201", "cf-ipcountry": "BR" },
    });
    await call(`/${ns}/ls`, { headers: { "cf-connecting-ip": "203.0.113.202" } });
    await sendText(ns, "just once", { burn: "1" });
    await call(`/${ns}/new`, { method: "POST", body: "a file" });
    const burn = (await json<Item[]>(`/${ns}/ls`)).find((item) => item.burn);
    await call(defined(burn, "the burn-after-reading item").contentUrl);

    const after = await stats();
    expect(after.sentToday - before.sentToday).toBe(2);
    expect(after.openedOnceLast7Days - before.openedOnceLast7Days).toBe(1);
    expect(after.totalItems - before.totalItems).toBe(1);
    expect(after.visitorsLast24h - before.visitorsLast24h).toBe(1);
    expect(after.topCountriesLast24h.some((entry) => entry.country === "BR")).toBe(true);

    const published = await (await call("/stats.json")).text();
    expect(published).not.toContain(ns);
    expect(published).not.toContain("203.0.113");
  });
});

describe("config", () => {
  test("disables the admin without a key and refuses short keys", () => {
    expect(loadConfig({}, CLOUDFLARE_LIMITS).adminKey).toBeNull();
    expect(() => loadConfig({ ADMIN_KEY: "short" }, CLOUDFLARE_LIMITS)).toThrow(/at least/);
    expect(loadConfig({ ADMIN_KEY: TEST_ADMIN_KEY }, CLOUDFLARE_LIMITS).adminKey).toBe(
      TEST_ADMIN_KEY,
    );
    // Cloudflare's own limits cap the sizes.
    expect(() => loadConfig({ MAX_FILE_BYTES: "200000000" }, CLOUDFLARE_LIMITS)).toThrow(
      /MAX_FILE_BYTES/,
    );
    expect(() => loadConfig({ MAX_TEXT_BYTES: "2000000" }, CLOUDFLARE_LIMITS)).toThrow(
      /MAX_TEXT_BYTES/,
    );
  });
});

describe("admin dashboard", () => {
  const auth = { authorization: `Bearer ${TEST_ADMIN_KEY}` };
  test("shows storage and namespaces, paged, and links to the logs", async () => {
    const ns = fresh("adm");
    await emptied(ns);
    for (let index = 0; index < 3; index += 1) await sendText(fresh(`${ns}-`), "x");

    type NamespacesPage = { total: number; items: { name: string; items: number }[] };
    const namespaces = await json<NamespacesPage>(`/a/namespaces?q=${ns}&limit=2`, {
      headers: auth,
    });
    expect(namespaces).toMatchObject({ total: 4, limit: 2 });
    expect(namespaces.items).toHaveLength(2);
    const exact = await json<NamespacesPage>(`/a/namespaces?q=${ns}&limit=500`, {
      headers: auth,
    });
    expect(exact.items).toContainEqual({ name: ns, items: 0 });

    const overview = await json<{ namespaces: { count: number }; logsUrl: string | null }>(
      "/a/overview",
      { headers: auth },
    );
    expect(overview.namespaces.count).toBeGreaterThanOrEqual(4);
    expect(overview.logsUrl).toContain("observability");
    for (const gone of ["traces", "errors", "logs"]) {
      expect((await call(`/a/${gone}`, { headers: auth })).status).toBe(404);
    }
  });
});
