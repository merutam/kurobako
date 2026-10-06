// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The self-hosted server, end to end: a real Bun server on a free port, its
// SQLite files in a temporary directory and file contents in memory.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
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
import { formatBytes as pageFormatBytes } from "../public/common.js";
import {
  TEXT_PREVIEW_CHARS as CLI_TEXT_PREVIEW_CHARS,
  detectImage as cliDetectImage,
  defaultTextName as clientDefaultName,
  formatBytes as cliFormatBytes,
  fileMetadata,
  VERSION as K_VERSION,
  openSealedSpace,
  openSharedItem,
  safeName,
} from "../public/k.mjs";
import type { Manifest } from "../src/api/archives";
import { readArchive, writeArchive } from "../src/archive";
import { startRouter } from "../src/bun/router";
import { startServer } from "../src/bun/server";
import { type AppConfig, loadConfig } from "../src/config";
import { detectImage, safeFileName, safeImageName } from "../src/image";
import { defaultTextName, TEXT_PREVIEW_CHARS } from "../src/model";
import { isAutomatedNetwork, networkKey } from "../src/networks";
import { ICON_FILES, STATIC_FILES } from "../src/pages";
import type { BlobStore } from "../src/platform";
import { clientKey } from "../src/request-info";
import { routeOf, SLOT_COUNT, slotOf, slotOwners, slotPrefix, tokenSlot } from "../src/routing";
import { TEST_ADMIN_KEY } from "./admin-key";
import { type Harness, sharedTests } from "./shared";
import { defined, type FileItem, type Item, type LiveMessage, type SharedItem } from "./support";

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
  // These tests read many things that are not there, from one address.
  missesPerMinute: 1_000,
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
    expect(await (await call(`/${ns}/1/c`)).text()).toBe("hello");

    const image = await json<FileItem>(`/${ns}/photo.png`, { method: "PUT", body: png });
    expect(image).toMatchObject({ kind: "image", filename: "photo.png" });
    expect(new Uint8Array(await (await call(`/${ns}/${image.id}`)).arrayBuffer())).toEqual(png);
    expect((await call(`/${ns}/${image.id}/d`)).headers.get("content-disposition")).toContain(
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
      lines.push(Bun.stripANSI(String(line))),
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

  test("gives each item its own time, in the queue's order, however fast they come", async () => {
    const ns = fresh();
    for (let index = 0; index < 3; index += 1) await typed(ns, `quick ${index}`);
    const times = (await json<Item[]>(`/${ns}/ls`)).map((item) => Date.parse(item.createdAt));
    // Newest first: strictly decreasing.
    expect(times.every((time, index) => index === 0 || time < (times[index - 1] as number))).toBe(
      true,
    );
  });

  test("consumes burn-after-reading items once", async () => {
    const ns = fresh();
    const item = await typed(ns, "once", { burn: "1" });
    expect(item.text).toBeUndefined();
    expect(await (await call(`/${ns}/${item.id}`)).text()).toBe("once");
    expect((await call(`/${ns}/${item.id}`)).status).toBe(404);
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
    const { open } = await openSharedItem(keyText, shared.metadata, shared.size);
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
    const listed = JSON.parse(await k(`${link}/ls`));
    expect(listed).toMatchObject([
      { kind: "text", burn: true },
      { kind: "text", name: "first text", text: "first text" },
    ]);
    // Burn-after-reading texts have no name.
    expect(listed[0].name).toBeUndefined();
    expect(await k(link)).toContain("deletes when opened");

    // Items by position: 1 is the newest. Reading a burn-after-reading item consumes it.
    expect(await k(`${link}/2`)).toBe("first text");
    expect(await k(`${link}/2/c`)).toBe("first text");
    expect(await k(`${link}/1`)).toBe("second text");
    expect(JSON.parse(await k(`${link}/ls`))).toHaveLength(1);

    // Files: -T to the namespace, contents to a pipe, -o, -OJ.
    writeFileSync(join(workDir, "picture.png"), png);
    expect(JSON.parse(await k("-T", "picture.png", `${link}/`))).toMatchObject({
      kind: "image",
      filename: "picture.png",
    });
    expect((await run([`${link}/1`])).out).toEqual(png);
    expect((await run([`${link}/1/`])).out).toEqual(png);
    await k("-o", "copy.png", `${link}/1`);
    expect(new Uint8Array(readFileSync(join(workDir, "copy.png")))).toEqual(png);
    expect((await run(["-OJ", `${link}/1/d`])).error).toContain(
      "Refusing to overwrite picture.png",
    );
    rmSync(join(workDir, "picture.png"));
    await k("-OJ", `${link}/1/d`);
    expect(new Uint8Array(readFileSync(join(workDir, "picture.png")))).toEqual(png);
    writeFileSync(join(workDir, "d"), "local edit");
    await k("-O", `${link}/1/d`);
    expect(new Uint8Array(readFileSync(join(workDir, "d")))).toEqual(png);

    // <item>.json: details, position and a share link with the item's key.
    const described = JSON.parse(await k(`${link}/1.json`));
    expect(described).toMatchObject({ kind: "image", position: 1, filename: "picture.png" });
    expect(described.shareUrl).toMatch(/\/i\/[A-Za-z0-9_-]{14}#.+/);
    expect((await run([described.shareUrl])).out).toEqual(png);

    // A share link carries the item's key and works on its own.
    const url = (await k(`${link}/1/s`)).trim();
    expect((await k("-X", "POST", `${link}/1/s`)).trim()).toBe(url);
    expect(url).toMatch(/\/i\/[A-Za-z0-9_-]{14}#/);
    expect((await run([url])).out).toEqual(png);

    // -O on the bare link saves every item; DELETE removes one.
    const all = mkdtempSync(join(tmpdir(), "kurobako-all-"));
    const saveAll = Bun.spawn(["bun", script, "-O", link], { cwd: all, stdout: "pipe" });
    await saveAll.exited;
    // As with curl: -d @file drops line breaks, --data-binary @file keeps them.
    // (In a namespace of its own: the queue here holds three items.)
    const lines = `${base}/e#${encodeURIComponent(`lines ${crypto.randomUUID()}`)}`;
    writeFileSync(join(workDir, "lines.txt"), "one\ntwo\r\n");
    expect(JSON.parse(await k("-d", "@lines.txt", `${lines}/new`)).text).toBe("onetwo");
    expect(JSON.parse(await k("--data-binary", "@lines.txt", `${lines}/new`)).text).toBe(
      "one\ntwo\r\n",
    );
    expect(JSON.parse(await k("--data-raw", "@lines.txt", `${lines}/new`)).text).toBe("@lines.txt");

    // Texts under their name, as the server names plain downloads.
    expect(readdirSync(all).sort()).toEqual(["first text.txt", "picture.png"]);
    // Again: every item is exported, overwriting as curl's -O does.
    writeFileSync(join(all, "first text.txt"), "local edit");
    writeFileSync(join(all, "picture.png"), "local edit");
    const again = Bun.spawn(["bun", script, "-O", link], { cwd: all, stdout: "pipe" });
    const report = await new Response(again.stdout).text();
    expect(report).toContain("→ first text.txt");
    expect(report).toContain("→ picture.png");
    expect(readFileSync(join(all, "first text.txt"), "utf8")).toBe("first text");
    expect(new Uint8Array(readFileSync(join(all, "picture.png")))).toEqual(png);
    expect(readdirSync(all)).toHaveLength(2);

    // --no-clobber keeps the old safety behavior.
    writeFileSync(join(all, "picture.png"), "keep me");
    const protectedRun = Bun.spawn(["bun", script, "--no-clobber", "-O", link], {
      cwd: all,
      stdout: "pipe",
      stderr: "pipe",
    });
    const protectedError = await new Response(protectedRun.stderr).text();
    expect(await protectedRun.exited).toBe(1);
    expect(protectedError).toContain("Refusing to overwrite picture.png");
    expect(readFileSync(join(all, "picture.png"), "utf8")).toBe("keep me");

    // -o - is standard output, as in curl, never a file named "-".
    const printed = await run(["-o", "-", `${link}/picture`]);
    expect(printed.code).toBe(0);
    expect(printed.out.slice(0, 4)).toEqual(png.slice(0, 4));
    expect(existsSync(join(workDir, "-"))).toBe(false);
    expect(JSON.parse(await k("-X", "DELETE", `${link}/1`))).toEqual({ ok: true });
    expect(JSON.parse(await k(`${link}/ls`))).toHaveLength(1);

    // Plain links pass through as curl would send them; JSON prints as for
    // an encrypted namespace, and errors go to standard error.
    const ns = fresh();
    expect(await k(`${link}/ls`)).toContain('\n  {\n    "id"');
    expect(await k("-d", "plain text", `${base}/${ns}/new`)).toContain('\n  "id": ');
    expect(await k(`${base}/${ns}/ls`)).toContain('\n  {\n    "id"');
    const missing = await run([`${base}/${ns}/9`]);
    expect(missing).toMatchObject({ code: 1, error: "Item not found.\n" });
    expect(missing.out).toHaveLength(0);
    expect(await k(`${base}/${ns}/1`)).toBe("plain text");
    expect(await k(`${base}/${ns}`)).toContain("plain text");
    expect((await k(`${base}/${ns}/1/s`)).trim()).toMatch(/\/i\/[A-Za-z0-9_-]{14}$/);
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
        new URL(request.url).pathname === "/.well-known/kurobako"
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
    // Startup restores timers from an index, without opening any database.
    expect(existsSync(`${file}-shm`)).toBe(false);
    expect(await (await call(`/${ns}/1`)).text()).toBe("kept");
    expect(existsSync(file)).toBe(true);
    await call(`/${ns}/${item.id}`, { method: "DELETE" });
    await Bun.sleep(config.emptyNamespaceTtlMs + 300);
    expect(existsSync(file)).toBe(false);
    expect(await json<Item[]>(`/${ns}/ls`)).toEqual([]);
  });

  test("restores timers after a restart without visiting each namespace", async () => {
    const emptied = async () => {
      const ns = fresh();
      const item = await typed(ns, "gone soon");
      await call(`/${ns}/${item.id}`, { method: "DELETE" });
      return join(dataDir, "namespaces", "plain", `${ns}.sqlite`);
    };
    // Its cleanup is due while the server is down, and runs once it is back.
    const file = await emptied();
    await running.stop();
    await Bun.sleep(config.emptyNamespaceTtlMs);
    await start();
    await Bun.sleep(300);
    expect(existsSync(file)).toBe(false);
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
    maxTextBytes: 1_000_000,
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

  test("files Cloudflare serves without the Worker: those the pages load", async () => {
    const wrangler = await Bun.file(join(import.meta.dir, "..", "wrangler.jsonc")).text();
    const list = /"run_worker_first":\s*\[([^\]]*)\]/.exec(wrangler)?.[1] ?? "";
    const skipped = [...list.matchAll(/"!\/([^"]+)"/g)].map((match) => match[1]);
    expect([...skipped].sort()).toEqual([...STATIC_FILES, ...ICON_FILES].sort());
  });

  test("the send limit Cloudflare enforces is the one clients are told", async () => {
    const wrangler = await Bun.file(join(import.meta.dir, "..", "wrangler.jsonc")).text();
    const told = /"SENDS_PER_MINUTE":\s*"(\d+)"/.exec(wrangler)?.[1];
    const limiter =
      /"UPLOAD_LIMITER"[^}]*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/.exec(wrangler);
    expect(limiter?.[2]).toBe("60");
    expect(told).toBe(limiter?.[1]);
  });

  test("compose passes every setting on to the server", async () => {
    const root = join(import.meta.dir, "..");
    const read = (path: string) => Bun.file(join(root, path)).text();
    const names = (text: string, pattern: RegExp) =>
      new Set([...text.matchAll(pattern)].map((match) => match[1] as string));
    const read_ = [
      ...names(await read("src/config.ts"), /(?:integer|flag)\(\s*vars,\s*"([A-Z0-9_]+)"/g),
      ...names(await read("src/config.ts"), /vars\.([A-Z0-9_]+)/g),
      ...names(
        await read("src/bun/server.ts"),
        /(?:env\.|positiveInteger\(|required\()"?([A-Z0-9_]+)/g,
      ),
    ];
    const passed = names(await read("compose.yaml"), /^ {6}([A-Z0-9_]+):/gm);
    // Set inside the container by the Containerfile.
    const internal = new Set(["DATA_DIR", "HOST", "PORT"]);
    const missing = [...new Set(read_)].filter((name) => !passed.has(name) && !internal.has(name));
    expect(missing).toEqual([]);
  });

  test("the miss limit Cloudflare enforces is the one configured", async () => {
    const wrangler = await Bun.file(join(import.meta.dir, "..", "wrangler.jsonc")).text();
    const told = /"MISSES_PER_MINUTE":\s*"(\d+)"/.exec(wrangler)?.[1];
    const limiter =
      /"MISS_LIMITER"[^}]*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/.exec(wrangler);
    expect(limiter?.[2]).toBe("60");
    expect(told).toBe(limiter?.[1]);
    expect(told).toBe(String(loadConfig({}).missesPerMinute));
  });

  test("the protocol page's test vectors: computed here, and opened by k.mjs", async () => {
    const page = await Bun.file(join(import.meta.dir, "..", "public", "protocol.html")).text();
    const vector = (name: string) => {
      const value = new RegExp(`data-vector="${name}">([^<]*)<`).exec(page)?.[1];
      return defined(value, `the ${name} vector`).replaceAll("&quot;", '"');
    };
    const typed = "  cafe\u0301 horse battery  ";
    const name = Buffer.from(vector("name"), "hex");
    expect(name.toString("utf8")).toBe(typed.normalize("NFC").trim());

    const bits = pbkdf2Sync(name, "kurobako/sealed/v3", 600_000, 32, "sha256");
    expect(bits.toString("hex")).toBe(vector("pbkdf2"));
    expect(bits.subarray(0, 16).toString("base64url")).toBe(vector("id"));
    expect(bits.subarray(16).toString("hex")).toBe(vector("namespace-key"));

    const seal = (key: Uint8Array, ivStart: number, label: string, plain: Uint8Array) => {
      const iv = Uint8Array.from({ length: 12 }, (_, index) => ivStart + index);
      const cipher = createCipheriv("aes-128-gcm", key, iv);
      cipher.setAAD(Buffer.from(label));
      return Buffer.concat([
        iv,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64url");
    };
    const itemKey = Buffer.from(vector("item-key"), "hex");
    expect(itemKey.toString("base64url")).toBe(vector("item-key-text"));
    // AES-KW (RFC 3394), through Web Crypto: Bun's node:crypto has no key wrap.
    const kek = await crypto.subtle.importKey("raw", bits.subarray(16), "AES-KW", false, [
      "wrapKey",
    ]);
    const plainKey = await crypto.subtle.importKey("raw", itemKey, "AES-GCM", true, ["encrypt"]);
    const wrapped = await crypto.subtle.wrapKey("raw", plainKey, kek, "AES-KW");
    expect(Buffer.from(wrapped).toString("base64url")).toBe(vector("wrapped"));
    expect(seal(itemKey, 0x20, "kurobako/v3/metadata", Buffer.from(vector("metadata")))).toBe(
      vector("sealed-metadata"),
    );
    expect(seal(itemKey, 0x30, "kurobako/v3/body", Buffer.from("hello"))).toBe(vector("body"));

    // k.mjs agrees: the same ID, and it opens what the page shows.
    const space = await openSealedSpace(typed);
    expect(space.id).toBe(vector("id"));
    const header = `${vector("wrapped")}.${vector("sealed-metadata")}`;
    const sealedSize = Buffer.from(vector("body"), "base64url").byteLength;
    expect(sealedSize).toBe(33);
    const item = await space.openItem(header, sealedSize);
    expect(item.keyText).toBe(vector("item-key-text"));
    expect(item.metadata).toEqual({ kind: "text", title: "hello", size: 5 });
    const opened = await openSharedItem(vector("item-key-text"), header, sealedSize);
    const body = await opened.open(Buffer.from(vector("body"), "base64url"));
    expect(new TextDecoder().decode(body)).toBe("hello");

    // The same key, but a body never opens as metadata, nor metadata as a body:
    // not even contents that read as metadata, which would otherwise pass.
    const lookalike = Buffer.from(JSON.stringify({ filename: "x.exe" }));
    const asMetadata = seal(itemKey, 0x40, "kurobako/v3/metadata", lookalike);
    expect((await space.openItem(`${vector("wrapped")}.${asMetadata}`, 48)).metadata).toMatchObject(
      {
        kind: "file",
        filename: "x.exe",
      },
    );
    const asBody = seal(itemKey, 0x40, "kurobako/v3/body", lookalike);
    await expect(space.openItem(`${vector("wrapped")}.${asBody}`, 48)).rejects.toThrow();
    await expect(
      opened.open(Buffer.from(vector("sealed-metadata"), "base64url")),
    ).rejects.toThrow();
  });

  test("file types and names: k.mjs describes files as the server does", () => {
    const head = (...bytes: number[]) => new Uint8Array([...bytes, ...new Array(12).fill(0)]);
    const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
    const samples = [
      head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      head(0xff, 0xd8, 0xff, 0xe0),
      head(...ascii("GIF89a")),
      head(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")),
      head(0, 0, 0, 0x1c, ...ascii("ftypavif")),
      head(0, 0, 0, 0x1c, ...ascii("ftypheic")),
      head(0, 0, 0, 0x1c, ...ascii("ftypisom")),
      head(...ascii("%PDF-1.7")),
      new Uint8Array([0x89, 0x50]),
    ];
    for (const bytes of samples) {
      const server = detectImage(bytes);
      expect(cliDetectImage(bytes)).toEqual(server);
      for (const name of ["photo.jpeg", "Report 2024.pdf", "", "-rf", "a/b/c.tar.gz", "noext"]) {
        const expected = server
          ? safeImageName(name || "file", server.extension)
          : safeFileName(name || "file");
        expect(fileMetadata(bytes, name)).toMatchObject({
          filename: expected,
          mime: server?.mime ?? "application/octet-stream",
        });
      }
    }
    expect(CLI_TEXT_PREVIEW_CHARS).toBe(TEXT_PREVIEW_CHARS);
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

/** Two servers behind a router, each with its own data and hub, sharing one S3 store. */
describe("several servers", () => {
  const sharedBlobs = memoryStore();
  const dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), "kurobako-node-")));
  let nodes: Awaited<ReturnType<typeof startServer>>[] = [];
  let router: ReturnType<typeof startRouter>;
  let front = "";
  const via = (path: string, init?: RequestInit) => fetch(`${front}${path}`, init);
  const send = async (ns: string, text: string) =>
    (
      await via(`/${ns}/new`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: text,
      })
    ).json() as Promise<Item>;
  const nodeHolding = (ns: string) =>
    dirs.findIndex((dir) => existsSync(join(dir, "namespaces", "plain", `${ns}.sqlite`)));

  beforeAll(async () => {
    nodes = await Promise.all(
      dirs.map((dataDir) =>
        startServer({
          // Every test here sends from one address.
          config: { ...config, adminKey: TEST_ADMIN_KEY, sendsPerMinute: 1000 },
          dataDir,
          blobs: sharedBlobs.store,
          port: 0,
          hostname: "127.0.0.1",
          clientIpHeader: "x-forwarded-for",
          logRequests: false,
        }),
      ),
    );
    router = startRouter({
      servers: nodes.map((node) => node.server.url.origin),
      port: 0,
      hostname: "127.0.0.1",
    });
    front = router.url.origin;
  });
  afterAll(async () => {
    await router.stop(true);
    for (const node of nodes) await node.stop();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("each namespace lives on the server that owns its slot", async () => {
    const origins = nodes.map((node) => node.server.url.origin);
    const owners = slotOwners(origins);
    const names = Array.from({ length: 24 }, fresh);
    for (const ns of names) await send(ns, `in ${ns}`);
    for (const ns of names) {
      const owner = origins.indexOf(owners[slotOf({ space: "plain", name: ns })] as string);
      expect(nodeHolding(ns)).toBe(owner);
      expect(await (await via(`/${ns}/1`)).text()).toBe(`in ${ns}`);
    }
    // Both servers got some.
    expect(new Set(names.map(nodeHolding))).toEqual(new Set([0, 1]));
  });

  test("share links reach the namespace's server", async () => {
    const ns = fresh();
    await send(ns, "shared across");
    const link = (await (await via(`/${ns}/1/s`)).text()).trim();
    const token = new URL(link).pathname.split("/")[2] ?? "";
    expect(tokenSlot(token)).toBe(slotOf({ space: "plain", name: ns }));
    expect(await (await via(`/i/${token}/c`)).text()).toBe("shared across");
  });

  test("relays live updates both ways", async () => {
    const ns = fresh();
    const socket = new WebSocket(`${front.replace("http", "ws")}/${ns}/live`);
    expect((await nextMessage(socket)).items).toEqual([]);
    const update = nextMessage(socket);
    await send(ns, "live through the router");
    expect((await update).items[0]).toMatchObject({ text: "live through the router" });
    const pong = new Promise((resolve) =>
      socket.addEventListener("message", (event) => resolve(event.data), { once: true }),
    );
    socket.send("ping");
    expect(await pong).toBe("pong");
    socket.close();
  });

  test("adds up every server's stats", async () => {
    const each = await Promise.all(
      nodes.map(async (node) => (await fetch(`${node.server.url.origin}/stats.json`)).json()),
    );
    const total = (await (await via("/stats.json")).json()) as { totalItems: number };
    expect(total.totalItems).toBe(
      each.reduce((sum: number, stats) => sum + (stats as { totalItems: number }).totalItems, 0),
    );
    expect(total.totalItems).toBeGreaterThan(0);
  });

  test("passes the client's address on, and only the real one", async () => {
    // At the edge, the router ignores an address or location the client claims.
    const spoofed = fresh();
    await via(`/${spoofed}/new`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.9", "cf-ipcountry": "AQ" },
      body: "spoofed",
    });
    const spoofedLog = await fetch(
      `${nodes[nodeHolding(spoofed)]?.server.url.origin}/${spoofed}/log.json`,
    );
    expect(spoofedLog.ok).toBe(true);
    const text = await spoofedLog.text();
    expect(text).toContain("127.0.0.1");
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("AQ");
  });
  test("the dashboard looks at one server at a time; logins go to the first", async () => {
    const auth = { authorization: `Bearer ${TEST_ADMIN_KEY}` };
    const names = Array.from({ length: 8 }, fresh);
    for (const ns of names) await send(ns, "listed");
    for (const index of nodes.keys()) {
      const response = await via(`/a/namespaces?server=${index + 1}&limit=500`, { headers: auth });
      expect(response.headers.get("X-Kurobako-Server")).toBe(String(index + 1));
      expect(response.headers.get("X-Kurobako-Servers")).toBe("2");
      const { items } = (await response.json()) as { items: { name: string }[] };
      const listed = new Set(items.map((item) => item.name));
      for (const ns of names) expect(listed.has(ns)).toBe(nodeHolding(ns) === index);
    }
    // Out of range: the first server. Logged out: nothing said about the others.
    const outOfRange = await via("/a/overview?server=9", { headers: auth });
    expect(outOfRange.headers.get("X-Kurobako-Server")).toBe("1");
    expect((await via("/a/overview?server=2")).headers.get("X-Kurobako-Servers")).toBeNull();

    // Failed logins count on the first server, whichever one the page looks at.
    const wrong = { method: "POST", body: JSON.stringify({ key: "wrong" }) };
    for (let attempt = 0; attempt < 5; attempt += 1) await via("/a/login?server=2", wrong);
    expect((await via("/a/login", wrong)).status).toBe(429);
    const second = nodes[1]?.server.url.origin;
    const direct = await fetch(`${second}/a/login`, {
      ...wrong,
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(direct.status).toBe(401);
  });
});

describe("slots", () => {
  test("spread evenly, and a new server takes only its share", () => {
    const three = slotOwners(["http://a:3000", "http://b:3000", "http://c:3000"]);
    const four = slotOwners(["http://a:3000", "http://b:3000", "http://c:3000", "http://d:3000"]);
    for (const server of new Set(three)) {
      const share = three.filter((owner) => owner === server).length / SLOT_COUNT;
      expect(share).toBeGreaterThan(0.3);
      expect(share).toBeLessThan(0.37);
    }
    const moved = three.filter((owner, slot) => owner !== four[slot]);
    expect(moved.length / SLOT_COUNT).toBeLessThan(0.3);
    // Every slot that moved went to the new server.
    expect(
      four.filter((owner, slot) => owner !== three[slot]).every((o) => o === "http://d:3000"),
    ).toBe(true);
  });

  test("namespaces spread over the slots", () => {
    const counts = new Array<number>(16).fill(0);
    for (let index = 0; index < 16_000; index += 1) {
      const slot = slotOf({ space: "plain", name: `name-${index}` });
      counts[slot % 16] = (counts[slot % 16] ?? 0) + 1;
    }
    for (const count of counts) expect(Math.abs(count - 1000)).toBeLessThan(150);
  });

  test("routes requests by path", () => {
    const sealed = "AAECAwQFBgcICQoLDA0ODw";
    expect(routeOf("/notes/ls")).toBe(slotOf({ space: "plain", name: "notes" }));
    expect(routeOf("/notes")).toBe(routeOf("/notes/1/d"));
    expect(routeOf(`/e/${sealed}/live`)).toBe(slotOf({ space: "sealed", name: sealed }));
    expect(routeOf(`/i/${slotPrefix(1234)}abcdefghijkl.json`)).toBe(1234);
    for (const path of [
      "/",
      "/e",
      "/stats.json",
      "/k.mjs",
      "/a/overview",
      "/k/protocol",
      "/Notes",
    ]) {
      expect(routeOf(path)).toBeNull();
    }
  });
});

/** A site under a path of its domain, as when it shares the domain with another site. */
describe("under a base path", () => {
  const siteDir = mkdtempSync(join(tmpdir(), "kurobako-base-"));
  const workDir = mkdtempSync(join(tmpdir(), "kurobako-base-cli-"));
  let site: Awaited<ReturnType<typeof startServer>>;
  let origin = "";
  const at = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init);
  const k = async (...args: string[]) => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "public", "k.mjs"), ...args], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(error);
    return out;
  };

  beforeAll(async () => {
    site = await startServer({
      config: { ...config, basePath: "/k", adminKey: TEST_ADMIN_KEY },
      dataDir: siteDir,
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
    origin = site.server.url.origin;
  });
  afterAll(async () => {
    await site.stop();
    rmSync(siteDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test("answers only under its path, and describes itself at the root too", async () => {
    for (const path of ["/.well-known/kurobako", "/k/.well-known/kurobako"]) {
      expect(await (await at(path)).json()).toMatchObject({
        base: "/k",
        protocolUrl: "/k/k/protocol",
        clientUrl: "/k/k.mjs",
      });
    }
    const { protocolUrl, clientUrl } = (await (await at("/.well-known/kurobako")).json()) as {
      protocolUrl: string;
      clientUrl: string;
    };
    expect((await at(protocolUrl)).headers.get("content-type")).toContain("text/html");
    expect(await (await at(clientUrl)).text()).toContain("export const VERSION");
    expect((await at("/notes/ls")).status).toBe(404);
    expect((await at("/common.js")).status).toBe(404);
    expect((await at("/k/notes/ls")).status).toBe(200);
  });

  test("pages link to their files and pages under the path", async () => {
    for (const path of ["/k", "/k/", "/k/notes", "/k/e"]) {
      const html = await (await at(path)).text();
      const links = [...html.matchAll(/\b(?:src|href)="(\/[^"]*)"/g)].map((match) => match[1]);
      expect(links.length).toBeGreaterThan(3);
      for (const link of links) expect(link).toStartWith("/k/");
    }
    const script = await at("/k/namespace.js?v=1");
    expect(script.headers.get("content-type")).toContain("javascript");
    // Scripts import each other by relative paths, which stay under the path.
    expect(await script.text()).toContain('from "./common.js"');
  });

  test("items and share links are under the path", async () => {
    const sent = (await (
      await at("/k/notes/new", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "under k",
      })
    ).json()) as Item;
    expect(await (await at(`/k/notes/${sent.id}`)).text()).toBe("under k");

    const described = (await (await at("/k/notes/1.json")).json()) as { shareUrl: string };
    expect(described.shareUrl).toStartWith(`${origin}/k/i/`);
    expect(await (await fetch(`${described.shareUrl}/c`)).text()).toBe("under k");

    const socket = new WebSocket(`${origin.replace("http", "ws")}/k/notes/live`);
    const first = await nextMessage(socket);
    expect(first.items[0]?.id).toBe(sent.id);
    socket.close();
  });

  test("k.mjs -O exports a plain namespace and overwrites local names", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kurobako-mirror-"));
    const script = join(import.meta.dir, "..", "public", "k.mjs");
    const mirror = async () => {
      const child = Bun.spawn(["bun", script, "-O", `${origin}/k/mirror`], {
        cwd: folder,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, error] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if ((await child.exited) !== 0) throw new Error(error);
      return out;
    };
    const send = (body: string) =>
      at("/k/mirror/new", { method: "POST", headers: { "content-type": "text/plain" }, body });
    try {
      await send("first");
      await at("/k/mirror/shot.png", { method: "PUT", body: png });
      await mirror();
      expect(readdirSync(folder).sort()).toEqual(["first.txt", "shot.png"]);
      writeFileSync(join(folder, "first.txt"), "local edit");
      await send("second");
      const report = await mirror();
      expect(report).toContain("→ first.txt");
      expect(readdirSync(folder).sort()).toEqual(["first.txt", "second.txt", "shot.png"]);
      expect(readFileSync(join(folder, "first.txt"), "utf8")).toBe("first");
      expect(readFileSync(join(folder, "shot.png"))).toEqual(Buffer.from(png));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("the admin's session goes with the path", async () => {
    const login = await at("/k/a/login", {
      method: "POST",
      body: JSON.stringify({ key: TEST_ADMIN_KEY }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/k/a");
    const cookie = setCookie.split(";")[0] ?? "";
    expect((await at("/k/a/overview", { headers: { cookie } })).status).toBe(200);
  });

  test("k.mjs takes the site with its path, like curl", async () => {
    const box = `${origin}/k`;
    const sealed = `${box}/e#${encodeURIComponent(`base ${crypto.randomUUID()}`)}`;
    await k("-d", "sealed under k", `${sealed}/new`);
    expect(await k(`${sealed}/1`)).toBe("sealed under k");
    const link = (await k(`${sealed}/1/s`)).trim();
    expect(link).toStartWith(`${box}/i/`);
    expect(await k(link)).toBe("sealed under k");

    // A bare namespace lists its items; one under a path is told by the server.
    writeFileSync(join(workDir, "note.txt"), "a file under k");
    await k("-T", "note.txt", `${box}/files`);
    expect(await k(`${box}/files`)).toContain("note.txt");
    expect(await k(`${box}/files/note`)).toBe("a file under k");
  });
});

/** ACCESS_KEY: only those with the key use the site; share links stay open unless told otherwise. */
describe("a private instance", () => {
  const KEY = "a private key for tests";
  const dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), "kurobako-private-")));
  const workDir = mkdtempSync(join(tmpdir(), "kurobako-private-cli-"));
  let open: Awaited<ReturnType<typeof startServer>>;
  let closed: Awaited<ReturnType<typeof startServer>>;
  const bearer = { authorization: `Bearer ${KEY}` };
  const at = (path: string, init?: RequestInit) => fetch(`${open.server.url.origin}${path}`, init);
  const k = async (args: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "public", "k.mjs"), ...args], {
      cwd: workDir,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, error, code };
  };

  beforeAll(async () => {
    const start = (dataDir: string, publicShares: boolean) =>
      startServer({
        config: { ...config, accessKey: KEY, publicShares },
        dataDir,
        blobs: memoryStore().store,
        port: 0,
        hostname: "127.0.0.1",
        logRequests: false,
      });
    open = await start(dirs[0] as string, true);
    closed = await start(dirs[1] as string, false);
  });
  afterAll(async () => {
    await open.stop();
    await closed.stop();
    for (const dir of [...dirs, workDir]) rmSync(dir, { recursive: true, force: true });
  });

  test("turns away whoever has no key: people to the login, scripts with the reason", async () => {
    const page = await at("/notes?x=1", { headers: { accept: "text/html" }, redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`/k/login?next=${encodeURIComponent("/notes?x=1")}`);
    const api = await at("/notes/ls");
    expect(api.status).toBe(401);
    expect(((await api.json()) as { error: string }).error).toContain("private");
    expect((await at("/notes/new", { method: "POST", body: "x" })).status).toBe(401);
    expect((await at("/stats.json")).status).toBe(401);

    // What anyone may still see.
    expect(await (await at("/.well-known/kurobako")).json()).toMatchObject({ private: true });
    for (const path of ["/k/login", "/k/protocol", "/k/healthz", "/k.mjs", "/common.js"]) {
      expect((await at(path)).status).toBe(200);
    }
  });

  test("opens to the key: as a bearer, or through a login session", async () => {
    const sent = await at("/notes/new", {
      method: "POST",
      headers: { ...bearer, "content-type": "text/plain" },
      body: "mine",
    });
    expect(sent.status).toBe(201);

    expect(
      (await at("/k/login", { method: "POST", body: JSON.stringify({ key: "nope" }) })).status,
    ).toBe(401);
    const login = await at("/k/login", { method: "POST", body: JSON.stringify({ key: KEY }) });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toStartWith("kurobako_access=");
    const listed = (await (await at("/notes/ls", { headers: { cookie } })).json()) as Item[];
    expect(listed.map((item) => item.text)).toEqual(["mine"]);

    // Live updates too: the browser sends the session with the WebSocket.
    const origin = open.server.url.origin.replace("http", "ws");
    const socket = new WebSocket(`${origin}/notes/live`, { headers: { cookie } } as never);
    expect((await nextMessage(socket)).items).toHaveLength(1);
    socket.close();
  });

  test("share links open for anyone, unless PUBLIC_SHARES is false", async () => {
    const link = (await (await at("/notes/1/s", { headers: bearer })).text()).trim();
    const path = new URL(link).pathname;
    expect(await (await at(`${path}/c`)).text()).toBe("mine");

    const other = closed.server.url.origin;
    await fetch(`${other}/notes/new`, {
      method: "POST",
      headers: { ...bearer, "content-type": "text/plain" },
      body: "kept in",
    });
    const closedLink = (
      await (await fetch(`${other}/notes/1/s`, { headers: bearer })).text()
    ).trim();
    expect((await fetch(`${other}${new URL(closedLink).pathname}/c`)).status).toBe(401);
    expect((await fetch(`${other}/.well-known/kurobako`)).status).toBe(200);
  });

  test("k.mjs sends the key from KUROBAKO_KEY", async () => {
    const box = open.server.url.origin;
    const without = await k([`${box}/notes`]);
    expect(without.code).toBe(1);
    expect(without.error).toContain("private");
    const env = { KUROBAKO_KEY: KEY };
    expect((await k([`${box}/notes`], env)).out).toContain("mine");
    const sealed = `${box}/e#${encodeURIComponent(`private ${crypto.randomUUID()}`)}`;
    expect((await k(["-d", "secret", `${sealed}/new`], env)).code).toBe(0);
    expect((await k([`${sealed}/1`], env)).out).toBe("secret");
  });
});

/** Backups: a namespace as zip or tar, the whole instance through the admin, and back. */
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
  /** Every entry of an archive: the manifest, and each file's bytes by path. */
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
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "public", "k.mjs"), ...args], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
    });
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

    // -O follows the URL and calls this "tar"; -OJ takes the quoted name in
    // Content-Disposition. Options may follow the URL, as in curl.
    const archiveName = `${ns}-${new Date().toISOString().slice(0, 10)}.tar`;
    await k(`${servers[0]?.server.url.origin}/${ns}/tar`, "-OJ");
    expect(readdirSync(workDir)).toContain(archiveName);
    expect(existsSync(join(workDir, "tar"))).toBe(false);

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

  test("since=: only what was sent or renamed after", async () => {
    const ns = fresh();
    await from(`/${ns}/new`, text("old and untouched"));
    const old = (await (await from(`/${ns}/new`, text("old name"))).json()) as Item;
    const full = (await unpack(await from(`/${ns}/tar`))).bytes;
    const copy = fresh();
    expect(
      await (await to(`/${copy}/import`, { method: "POST", body: full })).json(),
    ).toMatchObject({
      restored: 2,
      skipped: 0,
    });
    await Bun.sleep(20);
    const cut = new Date().toISOString();
    const renamed = (await (
      await from(`/${ns}/${old.id}/n`, { method: "POST", body: "renamed after cut" })
    ).json()) as Item;
    await from(`/${ns}/new`, text("new"));
    const { bytes, manifest } = await unpack(await from(`/${ns}/tar?since=${cut}`));
    const items = defined(manifest.namespaces[0], "the namespace").items;
    expect(items.map((item) => item.name)).toEqual(["renamed after cut", "new"]);
    expect(items[0]?.updatedAt).toBe(renamed.updatedAt);
    expect(Date.parse(old.createdAt)).toBeLessThan(Date.parse(cut));
    expect(Date.parse(defined(renamed.updatedAt, "the rename time"))).toBeGreaterThanOrEqual(
      Date.parse(cut),
    );
    expect(
      await (await to(`/${copy}/import`, { method: "POST", body: bytes })).json(),
    ).toMatchObject({ restored: 2, skipped: 0 });
    const copied = (await (await to(`/${copy}/ls`)).json()) as Item[];
    expect(copied.find((item) => item.id === old.id)).toMatchObject({
      name: "renamed after cut",
      updatedAt: renamed.updatedAt,
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

    // Once extracted, k.mjs mirrors the namespace's read paths offline, and
    // also opens either the whole backup or one .sealed file directly.
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
          await fetch(`${origin}/a/import`, { method: "POST", headers: admin, body: backup })
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
      const whole = new Uint8Array(await (await from("/a/zip", { headers: admin })).arrayBuffer());
      expect(whole.byteLength).toBeGreaterThan(2 * 1_000);
      const restored = await fetch(`${origin}/a/import`, {
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
      const response = await from(`/a/zip?max=1000${after ? `&after=${after}` : ""}`, {
        headers: admin,
      });
      expect(response.headers.get("content-disposition")).toContain(`-part${round + 1}.zip`);
      const next = response.headers.get("x-kurobako-next");
      const { bytes, manifest } = await unpack(response);
      expect(manifest.next).toBe(next ?? undefined);
      parts.push(bytes);
      const items = manifest.namespaces.flatMap((ns) => ns.items.map((item) => [ns.name, item]));
      const size = items.reduce((sum, [, item]) => sum + (item as { size: number }).size, 0);
      expect(items.length === 1 || size <= 1000).toBe(true);
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
        const response = await fetch(`${origin}/a/import`, {
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

    expect((await from("/a/tar")).status).toBe(401);
    const backup = await from("/a/tar", { headers: admin });
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
        await fetch(`${origin}/a/import`, { method: "POST", headers: admin, body: bytes })
      ).json();
      expect(result).toMatchObject({ namespaces: manifest.namespaces.length });
      expect(await (await fetch(`${origin}/${plain}/1`)).text()).toBe("everything");
      expect(await k(`${origin}/e#${encodeURIComponent(name)}/1`)).toBe("encrypted too");
    } finally {
      await fresh2.stop();
    }
  });
});

/** MAX_STORAGE_BYTES: every item together, across namespaces, stays under it. */
describe("a storage limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "kurobako-storage-"));
  let limited: Awaited<ReturnType<typeof startServer>>;
  const at = (path: string, init?: RequestInit) =>
    fetch(`${limited.server.url.origin}${path}`, init);
  const file = (bytes: number) => ({ method: "PUT", body: new Uint8Array(bytes).fill(7) });

  beforeAll(async () => {
    limited = await startServer({
      config: { ...config, maxStorageBytes: 1_000, sendsPerMinute: 1000 },
      dataDir: dir,
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
  });
  afterAll(async () => {
    await limited.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses what would go past it, across namespaces, until room is made", async () => {
    expect(await (await at("/.well-known/kurobako")).json()).toMatchObject({
      maxStorageBytes: 1_000,
    });
    const [one, two] = [fresh(), fresh()];
    expect((await at(`/${one}/a.bin`, file(600))).status).toBe(201);
    const refused = await at(`/${two}/b.bin`, file(600));
    expect(refused.status).toBe(507);
    expect(((await refused.json()) as { error: string }).error).toContain("full");
    // What still fits goes in.
    expect((await at(`/${two}/new`, { method: "POST", body: "small" })).status).toBe(201);
    // Deleting makes room again.
    await at(`/${one}/1`, { method: "DELETE" });
    expect((await at(`/${two}/b.bin`, file(600))).status).toBe(201);

    // A backup needs room for all of it.
    const backup = new Uint8Array(await (await at(`/${two}/zip`)).arrayBuffer());
    expect((await at(`/${fresh()}/import`, { method: "POST", body: backup })).status).toBe(507);
  });

  test("is off unless set", () => {
    expect(loadConfig({}).maxStorageBytes).toBeNull();
    expect(loadConfig({ MAX_STORAGE_BYTES: "0" }).maxStorageBytes).toBeNull();
    expect(loadConfig({ MAX_STORAGE_BYTES: "5000000000" }).maxStorageBytes).toBe(5_000_000_000);
  });
});

/** Limits count clients: an IPv4 address, or an IPv6 /64 network, whatever address in it is used. */
describe("who a limit counts", () => {
  test("an IPv6 address by its /64, however it is written", () => {
    expect(clientKey("203.0.113.5")).toBe("203.0.113.5");
    expect(clientKey("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(clientKey("2001:0DB8:ABCD:0012::9")).toBe("2001:db8:abcd:12::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    // IPv4 as dual-stack servers report it is IPv4.
    expect(clientKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(clientKey("unknown")).toBe("unknown");
    expect(clientKey("1::2::3")).toBe("1::2::3");
  });

  test("sends from one /64 share a budget; other networks have their own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kurobako-keys-"));
    const limited = await startServer({
      config: { ...config, sendsPerMinute: 2 },
      dataDir: dir,
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      clientIpHeader: "cf-connecting-ip",
      logRequests: false,
    });
    const send = (ip: string) =>
      fetch(`${limited.server.url.origin}/${fresh()}/new`, {
        method: "POST",
        headers: { "cf-connecting-ip": ip, "content-type": "text/plain" },
        body: ip,
      }).then((response) => response.status);
    try {
      // Three addresses of one network: the third send is over its budget.
      expect(await send("2001:db8:1:2::a")).toBe(201);
      expect(await send("2001:db8:1:2::b")).toBe(201);
      expect(await send("2001:db8:1:2:ffff::c")).toBe(429);
      // Another /64, and IPv4 addresses, are other clients.
      expect(await send("2001:db8:1:3::a")).toBe(201);
      expect(await send("203.0.113.7")).toBe(201);
      expect(await send("203.0.113.8")).toBe(201);
    } finally {
      await limited.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** AUTOMATED_NETWORKS: hosting, cloud and VPN networks and Tor, told by ASN and country. */
describe("automated networks", () => {
  test("are told by network, and counted by block", () => {
    expect(isAutomatedNetwork({ asn: 16509, country: "US" })).toBe(true);
    expect(isAutomatedNetwork({ asn: 7922, country: "US" })).toBe(false);
    expect(isAutomatedNetwork({ asn: null, country: "T1" })).toBe(true);
    expect(isAutomatedNetwork({ asn: null, country: null })).toBe(false);
    expect(networkKey("203.0.113.77")).toBe("203.0.113.0/24");
    expect(networkKey(clientKey("2001:db8:1:2:3::9"))).toBe("2001:db8:1::/48");
    expect(networkKey("unknown")).toBe("unknown");
  });

  const serve = (mode: "allow" | "block") =>
    startServer({
      config: { ...config, automatedNetworks: mode, sendsPerMinute: 2 },
      dataDir: mkdtempSync(join(tmpdir(), "kurobako-networks-")),
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      clientIpHeader: "cf-connecting-ip",
      logRequests: false,
    });
  const sendFrom = (origin: string, headers: Record<string, string>) =>
    fetch(`${origin}/${fresh()}/new`, {
      method: "POST",
      headers: { ...headers, "content-type": "text/plain" },
      body: "hello",
    });

  test("block: no sends from them, reading as usual", async () => {
    const running = await serve("block");
    const origin = running.server.url.origin;
    try {
      const refused = await sendFrom(origin, {
        "cf-connecting-ip": "203.0.113.5",
        "cf-asn": "14061",
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toContain("VPNs");
      // Tor too, by Cloudflare's country for it.
      const tor = { "cf-connecting-ip": "203.0.113.6", "cf-ipcountry": "T1" };
      expect((await sendFrom(origin, tor)).status).toBe(403);
      // A home sends; the blocked network still reads.
      const ns = fresh();
      await fetch(`${origin}/${ns}/new`, {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.9", "content-type": "text/plain" },
        body: "readable",
      });
      const read = await fetch(`${origin}/${ns}/1`, { headers: tor });
      expect(await read.text()).toBe("readable");
    } finally {
      await running.stop();
    }
  });

  test("allow: counted like anyone, address by address", async () => {
    const running = await serve("allow");
    const origin = running.server.url.origin;
    try {
      for (let last = 1; last <= 4; last += 1) {
        const sent = await sendFrom(origin, {
          "cf-connecting-ip": `203.0.113.${last}`,
          "cf-asn": "16509",
        });
        expect(sent.status).toBe(201);
      }
    } finally {
      await running.stop();
    }
  });
});
