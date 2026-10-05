// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
// The self-hosted server, end to end: a real Bun server on a free port, its
// SQLite files in a temporary directory and file contents in memory.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBytes as pageFormatBytes } from "../public/common.js";
import {
  defaultTextName as clientDefaultName,
  formatBytes as cliFormatBytes,
  VERSION as K_VERSION,
  openSealedSpace,
  openSharedItem,
  safeName,
} from "../public/k.mjs";
import { startServer } from "../src/bun/server";
import { type AppConfig, loadConfig } from "../src/config";
import { safeFileName } from "../src/image";
import { defaultTextName } from "../src/model";
import type { BlobStore } from "../src/platform";
import { TEST_ADMIN_KEY } from "./admin-key";
import { type Harness, sharedTests } from "./shared";
import type { FileItem, Item, LiveMessage, SharedItem } from "./support";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const memoryStore = () => {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const store: BlobStore = {
    async put(key, body, size) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (bytes.byteLength !== size) throw new Error("Length mismatch.");
      objects.set(key, bytes);
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { body: new Blob([bytes]).stream(), size: bytes.byteLength } : null;
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
  };
  return { store, objects };
};

const config: AppConfig = {
  ...loadConfig({}),
  // Short enough to watch a cleanup happen.
  emptyNamespaceTtlMs: 300,
  maxItems: 3,
};
const dataDir = mkdtempSync(join(tmpdir(), "kurobako-test-"));
const blobs = memoryStore();
let running: Awaited<ReturnType<typeof startServer>>;
let base = "";

/** Request logs, off but for the test about them. */
let logRequests = false;
const start = async () => {
  running = await startServer({
    config,
    dataDir,
    blobs: blobs.store,
    port: 0,
    hostname: "127.0.0.1",
    logRequests,
    maxOpenDatabases: 2,
  });
  base = running.server.url.origin;
};
beforeAll(start);
afterAll(async () => {
  await running.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

/*
 * Everything that holds on every platform (test/shared.ts), on a server of
 * its own with the default settings. It sits behind a pretend proxy that
 * names the client in cf-connecting-ip, so each call can come from its own
 * address, as on Cloudflare.
 */
describe("shared", () => {
  const sharedConfig = loadConfig({ ADMIN_KEY: TEST_ADMIN_KEY });
  const sharedDir = mkdtempSync(join(tmpdir(), "kurobako-shared-"));
  const sharedBlobs = memoryStore();
  let shared: Awaited<ReturnType<typeof startServer>>;
  let sharedBase = "";
  beforeAll(async () => {
    shared = await startServer({
      config: sharedConfig,
      dataDir: sharedDir,
      blobs: sharedBlobs.store,
      port: 0,
      hostname: "127.0.0.1",
      clientIpHeader: "cf-connecting-ip",
      logRequests: false,
    });
    sharedBase = shared.server.url.origin;
  });
  afterAll(async () => {
    await shared.stop();
    rmSync(sharedDir, { recursive: true, force: true });
  });

  sharedTests({
    describe,
    test,
    expect: expect as unknown as Harness["expect"],
    call: (path, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has("cf-connecting-ip")) {
        const [a, b] = crypto.getRandomValues(new Uint8Array(2));
        headers.set("cf-connecting-ip", `198.18.${a}.${b}`);
      }
      return fetch(`${sharedBase}${path}`, { ...init, headers });
    },
    storedFiles: async (prefix) =>
      [...sharedBlobs.objects.keys()].filter((key) => key.startsWith(prefix)),
    config: sharedConfig,
    get origin() {
      return sharedBase;
    },
    adminKey: TEST_ADMIN_KEY,
  });

  test("points the admin to its logs, which have no page of their own here", async () => {
    const overview = (await (
      await fetch(`${sharedBase}/a/overview`, {
        headers: { authorization: `Bearer ${TEST_ADMIN_KEY}` },
      })
    ).json()) as { logsUrl: string | null; logsHint: string | null };
    expect(overview.logsUrl).toBeNull();
    expect(overview.logsHint).toContain("standard output");
  });
});
const json = async <T>(path: string, init?: RequestInit) =>
  (await call(path, init)).json() as Promise<T>;
const fresh = () => `b${crypto.randomUUID().slice(0, 8)}`;
const typed = (ns: string, text: string, headers: Record<string, string> = {}) =>
  json<Item>(`/${ns}/new`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: text,
  });
const nextMessage = (socket: WebSocket) =>
  new Promise<LiveMessage>((resolve) =>
    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
      once: true,
    }),
  );

describe("bun server", () => {
  test("sends and reads texts and files the way curl does", async () => {
    const ns = fresh();
    expect(await typed(ns, "hello")).toMatchObject({ kind: "text", text: "hello" });
    expect(await (await call(`/${ns}/1`)).text()).toBe("hello");

    const image = await json<FileItem>(`/${ns}/photo.png`, { method: "PUT", body: png });
    expect(image).toMatchObject({ kind: "image", filename: "photo.png" });
    expect(new Uint8Array(await (await call(image.contentUrl)).arrayBuffer())).toEqual(png);
    expect((await call(image.downloadUrl)).headers.get("content-disposition")).toContain(
      "photo.png",
    );

    expect((await json<Item[]>(`/${ns}/ls`)).map((item) => item.kind)).toEqual(["image", "text"]);
    expect((await call(`/${ns}/1`, { method: "DELETE" })).status).toBe(200);
    expect(blobs.objects.size).toBe(0);
    expect((await call("/")).status).toBe(200);
    expect((await call("/k.mjs")).headers.get("content-type")).toContain("javascript");
    expect((await call("/favicon.ico")).headers.get("content-type")).toBe("image/x-icon");
    expect((await call("/apple-touch-icon.png")).status).toBe(200);
  });

  test("logs one line per request", async () => {
    const lines: string[] = [];
    const info = spyOn(console, "info").mockImplementation((line: unknown) =>
      // Without its colors.
      lines.push(String(line).replace(/\x1b\[\d+m/g, "")),
    );
    await running.stop();
    logRequests = true;
    await start();
    try {
      const ns = fresh();
      await call(`/${ns}/ls`);
      await call("/styles.css");
      expect(lines.some((line) => line.includes(`GET /${ns}/ls 200 `))).toBe(true);
      // Static files are left out, as on Cloudflare.
      expect(lines.some((line) => line.includes("/styles.css"))).toBe(false);
    } finally {
      info.mockRestore();
      await running.stop();
      logRequests = false;
      await start();
    }
  });

  test("consumes burn-after-reading items once", async () => {
    const ns = fresh();
    const item = await typed(ns, "once", { burn: "1" });
    expect(item.text).toBeUndefined();
    expect(await (await call(item.contentUrl)).text()).toBe("once");
    expect((await call(item.contentUrl)).status).toBe(404);
  });

  test("shares one item, and only with the right key when encrypted", async () => {
    const space = await openSealedSpace("bun shared secret");
    const { header, body, keyText } = await space.sealItem(new TextEncoder().encode("sealed"), {
      kind: "text",
      title: "sealed",
      size: 6,
    });
    const item = await json<Item>(`/e/${space.id}/new`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-sealed-metadata": header },
      body,
    });
    const url = new URL((await (await call(`/e/${space.id}/${item.id}/s`)).text()).trim()).pathname;
    const page = await (await call(url)).text();
    expect(page).not.toContain(space.id);
    const shared = await json<SharedItem>(`${url}.json`);
    const { open } = await openSharedItem(keyText, shared.metadata);
    const bytes = await open(await (await call(`${url}/c`)).arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("sealed");
  });

  test("k.mjs speaks curl, for encrypted and plain namespaces alike", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "kurobako-cli-"));
    const script = join(import.meta.dir, "..", "public", "k.mjs");
    const link = `${base}/e#${encodeURIComponent(`cli ${crypto.randomUUID()}`)}`;
    const run = async (args: string[], stdin?: string) => {
      const child = Bun.spawn(["bun", script, ...args], {
        cwd: workDir,
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, error, code] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { out: new Uint8Array(out), error, code };
    };
    const k = async (...args: string[]) => {
      const { out, error, code } = await run(args);
      if (code !== 0) throw new Error(error);
      return new TextDecoder().decode(out);
    };

    // Sending takes curl's -d and -T; a stray argument sends nothing.
    expect((await run([link, "oops"])).code).toBe(1);
    expect(JSON.parse(await k("-d", "first text", `${link}/new`))).toMatchObject({ kind: "text" });
    await run(["-H", "burn:1", "-d", "@-", `${link}/new`], "second text");

    // /ls is the plain API's JSON, decrypted; the bare link is a table.
    expect(JSON.parse(await k(`${link}/ls`))).toMatchObject([
      { kind: "text", burn: true },
      { kind: "text", text: "first text" },
    ]);
    expect(await k(link)).toContain("deletes when opened");

    // Items by position: 1 is the newest. Reading a burn-after-reading item consumes it.
    expect(await k(`${link}/2`)).toBe("first text");
    expect(await k(`${link}/1`)).toBe("second text");
    expect(JSON.parse(await k(`${link}/ls`))).toHaveLength(1);

    // Files: -T to the namespace, contents to a pipe, -o, -OJ.
    writeFileSync(join(workDir, "picture.png"), png);
    expect(JSON.parse(await k("-T", "picture.png", `${link}/`))).toMatchObject({
      kind: "image",
      filename: "picture.png",
    });
    expect((await run([`${link}/1`])).out).toEqual(png);
    await k("-o", "copy.png", `${link}/1`);
    expect(new Uint8Array(readFileSync(join(workDir, "copy.png")))).toEqual(png);
    expect((await run(["-OJ", `${link}/1/d`])).error).toContain(
      "Refusing to overwrite picture.png",
    );
    rmSync(join(workDir, "picture.png"));
    await k("-OJ", `${link}/1/d`);
    expect(new Uint8Array(readFileSync(join(workDir, "picture.png")))).toEqual(png);

    // <item>.json: details, position and a share link with the item's key.
    const described = JSON.parse(await k(`${link}/1.json`));
    expect(described).toMatchObject({ kind: "image", position: 1, filename: "picture.png" });
    expect(described.shareUrl).toMatch(/\/i\/[A-Za-z0-9_-]{12}#.+/);
    expect((await run([described.shareUrl])).out).toEqual(png);

    // A share link carries the item's key and works on its own.
    const url = (await k(`${link}/1/s`)).trim();
    expect((await k("-X", "POST", `${link}/1/s`)).trim()).toBe(url);
    expect(url).toMatch(/\/i\/[A-Za-z0-9_-]{12}#/);
    expect((await run([url])).out).toEqual(png);

    // -O on the bare link saves every item; DELETE removes one.
    const all = mkdtempSync(join(tmpdir(), "kurobako-all-"));
    const saveAll = Bun.spawn(["bun", script, "-O", link], { cwd: all, stdout: "pipe" });
    await saveAll.exited;
    expect(readdirSync(all).sort()).toEqual([
      "picture.png",
      expect.stringMatching(/^text-[a-z]{6}\.txt$/),
    ]);
    expect(JSON.parse(await k("-X", "DELETE", `${link}/1`))).toEqual({ ok: true });
    expect(JSON.parse(await k(`${link}/ls`))).toHaveLength(1);

    // Plain links pass through as curl would send them.
    const ns = fresh();
    await k("-d", "plain text", `${base}/${ns}/new`);
    expect(await k(`${base}/${ns}/1`)).toBe("plain text");
    expect(await k(`${base}/${ns}`)).toContain("plain text");
    expect((await k(`${base}/${ns}/1/s`)).trim()).toMatch(/\/i\/[A-Za-z0-9_-]{12}$/);
    expect(JSON.parse(await k(`${base}/${ns}/1.json`))).toMatchObject({
      text: "plain text",
      position: 1,
    });

    // A file name inside encrypted metadata reaches nobody but k.mjs, which cleans it.
    const space = await openSealedSpace(decodeURIComponent(link.split("#")[1] ?? ""));
    const hostile = await space.sealItem(png, {
      kind: "file",
      title: "x",
      filename: "../../CON.txt",
      mime: "text/plain",
      size: png.byteLength,
    });
    await call(`/e/${space.id}/new`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-sealed-metadata": hostile.header },
      body: hostile.body,
    });
    await k("-OJ", `${link}/1/d`);
    expect(new Uint8Array(readFileSync(join(workDir, "_CON.txt")))).toEqual(png);

    // -T to a bare namespace keeps the file's name, slash or not.
    expect(JSON.parse(await k("-T", "picture.png", `${base}/${ns}`))).toMatchObject({
      filename: "picture.png",
    });

    // /n renames: encrypted items get their metadata sealed again.
    expect(JSON.parse(await k("-d", "renamed.png", `${link}/1/n`))).toMatchObject({
      filename: "renamed.png",
    });
    expect(await k(link)).toContain("renamed.png");
    // Encrypted items by name, found by k.mjs in the decrypted list.
    expect((await run([`${link}/renamed.png`])).out).toEqual(png);
    expect((await run([`${link}/RENAMED`])).out).toEqual(png);
    expect(JSON.parse(await k(`${link}/renamed.png.json`))).toMatchObject({
      filename: "renamed.png",
    });
    expect(JSON.parse(await k("-d", "plain name", `${base}/${ns}/2/n`))).toMatchObject({
      name: "plain name",
    });

    // A link without its site, and a site that is no Kurobako server, say so.
    expect((await run(["/e#name"])).error).toContain("has no site in front");
    const other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<h1>Not here</h1>", {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
    });
    try {
      for (const target of [`${other.url.origin}/e#name`, `${other.url.origin}/ns/1`]) {
        expect((await run([target])).error).toContain("does not look like a Kurobako server");
      }
    } finally {
      await other.stop(true);
    }

    // A Kurobako server of another version: its error, and a hint to get its own k.mjs.
    const newer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) =>
        new URL(request.url).pathname === "/config.json"
          ? Response.json({
              version: "99.0.0",
              namespace: { pattern: "." },
              live: { ping: "ping" },
            })
          : Response.json({ error: "Item not found." }, { status: 404 }),
    });
    try {
      for (const target of [`${newer.url.origin}/e#name/1`, `${newer.url.origin}/ns/1`]) {
        const { error } = await run([target]);
        expect(error).toContain("Item not found.");
        expect(error).toContain("the server is 99.0.0");
      }
    } finally {
      await newer.stop(true);
    }

    // "/" ends the secret name, so a name cannot contain one.
    expect((await run([`${base}/e#${encodeURIComponent("a/b")}`])).error).toContain(
      'cannot contain "/"',
    );
    rmSync(workDir, { recursive: true });
    rmSync(all, { recursive: true });
  });

  test("pushes changes to live viewers", async () => {
    const ns = fresh();
    const socket = new WebSocket(`${base.replace("http", "ws")}/${ns}/live`);
    expect((await nextMessage(socket)).items).toEqual([]);
    const update = nextMessage(socket);
    await typed(ns, "live");
    expect((await update).items[0]).toMatchObject({ text: "live" });

    const pong = new Promise((resolve) =>
      socket.addEventListener("message", (e) => resolve(e.data), { once: true }),
    );
    socket.send("ping");
    expect(await pong).toBe("pong");
    socket.close();
  });

  test("keeps items across a restart and deletes a namespace once it is empty", async () => {
    const ns = fresh();
    const item = await typed(ns, "kept");
    await running.stop();
    await start();
    const file = join(dataDir, "namespaces", "plain", `${ns}.sqlite`);
    // Startup visits every namespace to restore its timers, but closes each
    // connection again instead of retaining one per database.
    expect(existsSync(`${file}-shm`)).toBe(false);
    expect(await (await call(`/${ns}/1`)).text()).toBe("kept");
    expect(existsSync(file)).toBe(true);
    await call(`/${ns}/${item.id}`, { method: "DELETE" });
    await Bun.sleep(config.emptyNamespaceTtlMs + 300);
    expect(existsSync(file)).toBe(false);
    expect(await json<Item[]>(`/${ns}/ls`)).toEqual([]);
  });

  test("limits sends per address", async () => {
    const ns = fresh();
    const statuses = [];
    for (let index = 0; index < 31; index += 1)
      statuses.push((await call(`/${ns}/new`, { method: "POST", body: "x" })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  test("keeps only the most recently used namespace databases open", async () => {
    for (let index = 0; index < 4; index += 1) await typed(fresh(), `database ${index}`);
    const directory = join(dataDir, "namespaces", "plain");
    const open = readdirSync(directory).filter((file) => file.endsWith(".sqlite-shm"));
    expect(open.length).toBeLessThanOrEqual(2);
  });
});

/**
 * k.mjs is a single file people download, so a few rules live both there and
 * in the server (or the pages). These must agree.
 */
test("a self-hosted server leaves its limits to configuration", () => {
  const config = loadConfig({
    MAX_FILE_BYTES: "20000000000",
    MAX_TEXT_BYTES: "4000000",
    INLINE_TEXT_BYTES: "256000",
  });
  expect(config).toMatchObject({
    maxFileBytes: 20_000_000_000,
    maxTextBytes: 4_000_000,
    inlineTextBytes: 256_000,
  });
  // The defaults stay the same everywhere.
  expect(loadConfig({})).toMatchObject({
    maxFileBytes: 100_000_000,
    maxTextBytes: 256_000,
    inlineTextBytes: 64_000,
  });
  expect(() => loadConfig({ MAX_FILE_BYTES: String(Number.MAX_SAFE_INTEGER) })).toThrow(
    /MAX_FILE_BYTES/,
  );
  expect(() => loadConfig({ MAX_TEXT_BYTES: "64000", INLINE_TEXT_BYTES: "256000" })).toThrow(
    /INLINE_TEXT_BYTES/,
  );
});

describe("rules kept in two places", () => {
  test("default text names", () => {
    const texts = [
      "short",
      "  spaced\n\tout  text ",
      `Shopping list for the weekend: ${"rice, beans, coffee, ".repeat(5)}`,
      "x".repeat(200),
      `${"word ".repeat(15)}end, and more punctuation!?`,
      "Ação, café e pão: uma lista com acentos que passa bem dos oitenta caracteres sim",
    ];
    for (const text of texts) expect(clientDefaultName(text)).toBe(defaultTextName(text));
  });

  test("safe file names", () => {
    const names = [
      "photo.jpg",
      "../../etc/passwd",
      "CON.txt",
      "-rf.sh",
      'a:b*c?"d<e>f|g.txt',
      "\u0000\u0007.hidden",
      "relatório ação.pdf",
      "   ",
      `${"long".repeat(40)}.tar`,
      "archive.tar.gz",
      "no-extension",
    ];
    for (const name of names) expect(safeName(name, "file")).toBe(safeFileName(name));
  });

  test("versions: k.mjs says which server version it comes from", async () => {
    const pkg = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as {
      version: string;
    };
    expect(K_VERSION).toBe(pkg.version);
  });

  test("byte sizes", () => {
    for (const bytes of [
      0, 1, 999, 1000, 1500, 9999, 10_000, 999_999, 1_000_000, 123_456_789, 5e9,
    ]) {
      expect(cliFormatBytes(bytes)).toBe(pageFormatBytes(bytes));
    }
  });
});
