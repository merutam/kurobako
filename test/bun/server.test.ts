// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The Bun server end to end.
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL as K_PROTOCOL,
  newViewId,
  openSealedSpace,
  openSharedItem,
} from "../../public/k.mjs";
import { STYLES } from "../../src/assets";
import { loadConfig } from "../../src/config";
import { fromBase64Url, skipIdOf, toBase64Url, vapidKeyProblem } from "../../src/domain/push";
import { startServer } from "../../src/infrastructure/bun/server";
import { bundle } from "../../src/web/client/build";
import { defined, type FileItem, type Item, type SharedItem } from "../support";
import {
  base,
  blobs,
  call,
  config,
  dataDir,
  fresh,
  json,
  memoryStore,
  nextMessage,
  png,
  running,
  setLogRequests,
  start,
  typed,
  useDefaultServer,
} from "./harness";

useDefaultServer();

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
    const favicon = await call("/favicon.svg");
    expect(favicon.headers.get("content-type")).toBe("image/svg+xml");
    expect(await favicon.text()).toContain('viewBox="0 0 120 120"');
    expect((await call("/apple-touch-icon.png")).status).toBe(200);
  });

  test("logs one line per request", async () => {
    const lines: string[] = [];
    const info = spyOn(console, "info").mockImplementation((line: unknown) =>
      // Without its colors.
      lines.push(Bun.stripANSI(String(line))),
    );
    await running.stop();
    setLogRequests(true);
    await start();
    try {
      const ns = fresh();
      await call(`/${ns}/ls`);
      const styles = `/k/assets/${defined((await bundle()).manifest.files[STYLES], "styles").file}`;
      expect((await call(styles)).status).toBe(200);
      expect(lines.some((line) => line.includes(`GET /${ns}/ls 200 `))).toBe(true);
      // Static files are left out, as on Cloudflare.
      expect(lines.some((line) => line.includes(styles))).toBe(false);
    } finally {
      info.mockRestore();
      await running.stop();
      setLogRequests(false);
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
      headers: {
        "content-type": "application/octet-stream",
        "x-sealed-metadata": header,
        "write-key": space.writeKey,
      },
      body,
    });
    const url = new URL(
      (
        await (
          await call(`/e/${space.id}/${item.id}/s`, {
            headers: { "write-key": space.writeKey },
          })
        ).text()
      ).trim(),
    ).pathname;
    const page = await (await call(url)).text();
    expect(page).not.toContain(space.id);
    const shared = await json<SharedItem>(`${url}.json`);
    const { open } = await openSharedItem(keyText, shared.metadata, shared.size);
    const bytes = await open(await (await call(`${url}/c`)).arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("sealed");
  });

  test("k.mjs speaks curl, for encrypted and plain namespaces alike", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "kurobako-cli-"));
    const script = join(import.meta.dir, "..", "..", "public", "k.mjs");
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

    // /e edits a text under the same item, using the version k.mjs just read.
    const encryptedEdit = JSON.parse(await k("-d", "first text, edited", `${link}/1/e`));
    expect(encryptedEdit).toMatchObject({ id: listed[1].id, text: "first text, edited" });
    expect(await k(`${link}/1`)).toBe("first text, edited");

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
    expect(JSON.parse(await k(`${url}/ls`))).toMatchObject([{ kind: "image" }]);

    const viewSpace = await openSealedSpace(`cli view ${crypto.randomUUID()}`);
    const sealedViewItem = await viewSpace.sealItem(new TextEncoder().encode("view text"), {
      kind: "text",
      title: "view text",
      size: 9,
    });
    const viewItem = await json<Item>(`/e/${viewSpace.id}/new`, {
      method: "POST",
      headers: {
        "x-sealed-metadata": sealedViewItem.header,
        "write-key": viewSpace.writeKey,
      },
      body: sealedViewItem.body,
    });
    const viewId = newViewId();
    const view = await json<{ url: string }>(`/e/${viewSpace.id}/views`, {
      method: "POST",
      headers: { "write-key": viewSpace.writeKey },
      body: JSON.stringify({
        viewId,
        previousToken: null,
        entries: [
          {
            id: viewItem.id,
            envelope: await viewSpace.sealViewEntry(viewId, sealedViewItem.keyText),
          },
        ],
      }),
    });
    const viewLink = `${base}${view.url}#${await viewSpace.viewKey(viewId)}`;
    expect(JSON.parse(await k(`${viewLink}/ls`))).toMatchObject([
      { kind: "text", name: "view text", text: "view text" },
    ]);
    expect(JSON.parse(await k(`${viewLink}/ls?summary`))).toHaveLength(1);
    expect(await k(viewLink)).toContain("view text");

    // -O on the bare link saves every item; DELETE removes one.
    const all = mkdtempSync(join(tmpdir(), "kurobako-all-"));
    const saveAll = Bun.spawn(["bun", script, "-O", link], { cwd: all, stdout: "pipe" });
    await saveAll.exited;
    // As with curl: -d @file drops line breaks, --data-binary @file keeps them.
    const lines = `${base}/e#${encodeURIComponent(`lines ${crypto.randomUUID()}`)}`;
    writeFileSync(join(workDir, "lines.txt"), "one\ntwo\r\n");
    expect(JSON.parse(await k("-d", "@lines.txt", `${lines}/new`)).text).toBe("onetwo");
    expect(JSON.parse(await k("--data-binary", "@lines.txt", `${lines}/new`)).text).toBe(
      "one\ntwo\r\n",
    );
    expect(JSON.parse(await k("--data-raw", "@lines.txt", `${lines}/new`)).text).toBe("@lines.txt");

    // Texts under their name, as the server names plain downloads.
    expect(readdirSync(all).sort()).toEqual(["first text- edited.txt", "picture.png"]);
    // Again: every item is exported, overwriting as curl's -O does.
    writeFileSync(join(all, "first text- edited.txt"), "local edit");
    writeFileSync(join(all, "picture.png"), "local edit");
    const again = Bun.spawn(["bun", script, "-O", link], { cwd: all, stdout: "pipe" });
    const report = await new Response(again.stdout).text();
    expect(report).toContain("→ first text- edited.txt");
    expect(report).toContain("→ picture.png");
    expect(readFileSync(join(all, "first text- edited.txt"), "utf8")).toBe("first text, edited");
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

    // Plain links pass through as curl would send them; errors go to standard error.
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
    expect(JSON.parse(await k("-d", "plain edit", `${base}/${ns}/1/e`))).toMatchObject({
      text: "plain edit",
    });
    expect(await k(`${base}/${ns}/1`)).toBe("plain edit");

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
      headers: {
        "content-type": "application/octet-stream",
        "x-sealed-metadata": hostile.header,
        "write-key": space.writeKey,
      },
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

    const source = new TextEncoder().encode("export const answer = 42;\n");
    const namedText = await space.sealItem(source, {
      kind: "text",
      title: "answer.js",
      size: source.byteLength,
    });
    await call(`/e/${space.id}/new`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-sealed-metadata": namedText.header,
        "write-key": space.writeKey,
      },
      body: namedText.body,
    });
    await k("-OJ", `${link}/1/d`);
    expect(readFileSync(join(workDir, "answer.js"), "utf8")).toBe("export const answer = 42;\n");

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
              protocol: protocol(),
              clientUrl: "/k.mjs",
              namespace: { pattern: "." },
              live: { ping: "ping" },
            })
          : Response.json({ error: "Item not found." }, { status: 404 }),
    });
    let protocol = () => K_PROTOCOL;
    try {
      for (const target of [`${newer.url.origin}/e#name/1`, `${newer.url.origin}/ns/1`]) {
        const { error } = await run([target]);
        expect(error).toContain("Item not found.");
        expect(error).toContain("the server is 99.0.0");
      }
      // Another protocol: encrypted items are refused before anything is read.
      protocol = () => K_PROTOCOL + 1;
      const { error } = await run([`${newer.url.origin}/e#name/1`]);
      expect(error).toContain(
        `speaks the Kurobako protocol ${K_PROTOCOL} and the server ${K_PROTOCOL + 1}`,
      );
      expect(error).toContain("curl -O");
    } finally {
      await newer.stop(true);
    }

    // "/" ends the secret name, so a name cannot contain one.
    expect((await run([`${base}/e#${encodeURIComponent("a/b")}`])).error).toContain(
      'cannot contain "/"',
    );
    rmSync(workDir, { recursive: true });
    rmSync(all, { recursive: true });
  }, 30_000);

  test("pushes changes to live viewers", async () => {
    const ns = fresh();
    const socket = new WebSocket(`${base.replace("http", "ws")}/${ns}/live`);
    expect((await nextMessage(socket, "ready")).type).toBe("ready");
    const update = nextMessage(socket, "change");
    await typed(ns, "live");
    expect((await update).upserts[0]).toMatchObject({ text: "live" });

    const pong = new Promise((resolve) =>
      socket.addEventListener("message", (e) => resolve(e.data), { once: true }),
    );
    socket.send("ping");
    expect(await pong).toBe("pong");
    socket.close();
  });

  test("k.mjs rotates encrypted views and keeps new sends in the active one", async () => {
    const script = join(import.meta.dir, "..", "..", "public", "k.mjs");
    const link = `${base}/e#${encodeURIComponent(`views ${crypto.randomUUID()}`)}`;
    const k = async (...args: string[]) => {
      const child = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });
      const [out, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(error);
      return JSON.parse(out);
    };
    await k("-d", "one", `${link}/new`);
    const first = await k("-X", "POST", `${link}/views`);
    expect(first.url).toMatch(/\/v\/[A-Za-z0-9_-]{14}#[A-Za-z0-9_-]{22}$/);
    const viewJsonUrl = new URL(first.url);
    viewJsonUrl.pathname += ".json";
    expect((await k(viewJsonUrl.toString())).items).toHaveLength(1);
    await k("-d", "two", `${link}/new`);
    const firstPath = new URL(first.url).pathname;
    expect((await json<{ entries: unknown[] }>(`${firstPath}.json`)).entries).toHaveLength(2);
    const second = await k("-X", "POST", `${link}/views`);
    await k("-d", "three", `${link}/new`);
    expect((await json<{ entries: unknown[] }>(`${firstPath}.json`)).entries).toHaveLength(2);
    expect(
      (await json<{ entries: unknown[] }>(`${new URL(second.url).pathname}.json`)).entries,
    ).toHaveLength(3);
    expect((await k(`${link}/views`)).views).toHaveLength(2);

    // Its items are found as a namespace's, decrypted with the view's key.
    const raw = async (...args: string[]) => {
      const child = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });
      const [out, error] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { out, error };
    };
    expect((await raw(`${second.url}/1`)).out).toBe("three");
    expect((await raw(`${second.url}/3/c`)).out).toBe("one");
    const details = await k(`${second.url}/2.json`);
    expect(details).toMatchObject({ position: 2, text: "two" });
    expect(details.shareUrl).toMatch(/\/i\/[A-Za-z0-9_-]{14}#[A-Za-z0-9_-]{22}$/);
    const shared = (await raw(`${second.url}/2/s`)).out.trim();
    expect(shared).toBe(details.shareUrl);
    expect((await raw(shared)).out).toBe("two");
    expect((await raw(`${second.url}/9`)).error).toContain('No item "9" in this view.');
  });

  test("keeps items across a restart and deletes a namespace once it is empty", async () => {
    const ns = fresh();
    const item = await typed(ns, "kept");
    const view = await json<{ url: string }>(`/${ns}/views`, {
      method: "POST",
      body: JSON.stringify({
        viewId: newViewId(),
        previousToken: null,
        entries: [{ id: item.id }],
      }),
    });
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
    expect((await call(`${view.url}.json`)).status).toBe(404);
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
    for (let index = 0; index <= config.sendsPerMinute; index += 1)
      statuses.push((await call(`/${ns}/new`, { method: "POST", body: "x" })).status);
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  test("keeps only the most recently used namespace databases open", async () => {
    for (let index = 0; index < 4; index += 1) await typed(fresh(), `database ${index}`);
    const directory = join(dataDir, "namespaces", "plain");
    const open = readdirSync(directory).filter((file) => file.endsWith(".sqlite-shm"));
    expect(open.length).toBeLessThanOrEqual(2);
  });

  test("k.mjs follows a namespace live, a line per change", async () => {
    const own = await startServer({
      config: { ...config, sendsPerMinute: 1_000, maxItems: 20 },
      dataDir: mkdtempSync(join(tmpdir(), "kurobako-live-")),
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
    const script = join(import.meta.dir, "..", "..", "public", "k.mjs");
    const k = (...args: string[]) =>
      Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" }).exited;
    const follow = (link: string) => {
      const child = Bun.spawn(["bun", script, `${link}/live`], { stdout: "pipe", stderr: "pipe" });
      const lines: string[] = [];
      let wake = () => {};
      void (async () => {
        let rest = "";
        for await (const chunk of child.stdout) {
          rest += new TextDecoder().decode(chunk);
          const parts = rest.split("\n");
          rest = parts.pop() ?? "";
          lines.push(...parts);
          wake();
        }
      })();
      const next = async () => {
        const deadline = Date.now() + 5_000;
        while (!lines.length && Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 200);
          });
        }
        return lines.shift();
      };
      return { child, next };
    };
    try {
      for (const link of [
        `${own.server.url.origin}/${fresh()}`,
        `${own.server.url.origin}/e#${encodeURIComponent(`live ${crypto.randomUUID()}`)}`,
      ]) {
        await k("-d", "already there", `${link}/new`);
        const live = follow(link);
        // The queue it starts from prints nothing; changes do, decrypted.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await k("-d", "hello live", `${link}/new`);
        expect(await live.next()).toMatch(/^new [a-z]{6} hello live$/);
        await k("-d", "renamed now", `${link}/1/n`);
        expect(await live.next()).toMatch(/^changed [a-z]{6} renamed now$/);
        await k("-X", "DELETE", `${link}/1`);
        expect(await live.next()).toMatch(/^gone [a-z]{6}$/);
        live.child.kill();
      }

      // Plain only: encrypted contents differ every time they are sealed.
      const link = `${own.server.url.origin}/${fresh()}`;
      const file = join(mkdtempSync(join(tmpdir(), "kurobako-live-file-")), "photo.png");
      writeFileSync(file, png);
      await k("-T", file, `${link}/`);
      await k("-d", "on top", `${link}/new`);
      const live = follow(link);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await k("-T", file, `${link}/`);
      expect(await live.next()).toMatch(/^moved [a-z]{6} photo.png$/);
      live.child.kill();
    } finally {
      await own.stop();
    }
  }, 30_000);

  test("k.mjs streams an item, and serves it to a player in parts", async () => {
    // Its own server: the shared one's send limit is spent by other tests.
    const own = await startServer({
      config: { ...config, sendsPerMinute: 1_000 },
      dataDir: mkdtempSync(join(tmpdir(), "kurobako-play-data-")),
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
    const script = join(import.meta.dir, "..", "..", "public", "k.mjs");
    const workDir = mkdtempSync(join(tmpdir(), "kurobako-play-"));
    const link = `${own.server.url.origin}/e#${encodeURIComponent(`play ${crypto.randomUUID()}`)}`;
    // Four segments, the last one short.
    const media = new Uint8Array(3 * 65_536 + 1_000).map(
      (_, index) => (index * 31 + (index >> 9)) & 255,
    );
    writeFileSync(join(workDir, "clip.bin"), media);
    const run = async (...args: string[]) => {
      const child = Bun.spawn(["bun", script, ...args], {
        cwd: workDir,
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
    expect((await run("-T", "clip.bin", `${link}/`)).code).toBe(0);

    // Standard output, a segment at a time.
    expect((await run("-o", "-", `${link}/1`)).out).toEqual(media);

    // serve: the address on its first line, then any part of the contents.
    const serving = Bun.spawn(["bun", script, "serve", `${link}/1`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = serving.stdout.getReader();
      let printed = "";
      while (!printed.includes("\n"))
        printed += new TextDecoder().decode((await reader.read()).value);
      const address = printed.trim();
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/clip\.bin$/);
      const whole = await fetch(address);
      expect(whole.headers.get("accept-ranges")).toBe("bytes");
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(media);
      for (const [range, start, end] of [
        ["bytes=0-99", 0, 99],
        ["bytes=65530-65545", 65_530, 65_545],
        ["bytes=100000-", 100_000, media.length - 1],
        ["bytes=-10", media.length - 10, media.length - 1],
      ] as const) {
        const part = await fetch(address, { headers: { Range: range } });
        expect(part.status).toBe(206);
        expect(part.headers.get("content-range")).toBe(`bytes ${start}-${end}/${media.length}`);
        expect(new Uint8Array(await part.arrayBuffer())).toEqual(media.slice(start, end + 1));
      }
      expect((await fetch(address, { headers: { Range: `bytes=${media.length}-` } })).status).toBe(
        416,
      );
      // Another path on that port is nothing.
      expect((await fetch(new URL("/", address))).status).toBe(404);
    } finally {
      serving.kill();
    }

    // play: the player gets the address last, after its own options.
    writeFileSync(
      join(workDir, "player.mjs"),
      `import { writeFileSync } from "node:fs";
       const bytes = await (await fetch(process.argv.at(-1))).arrayBuffer();
       writeFileSync(process.argv[2], new Uint8Array(bytes));`,
    );
    const played = await run(
      "play",
      "--player",
      "bun",
      `${link}/1`,
      "--",
      "player.mjs",
      "played.bin",
    );
    expect(played.code).toBe(0);
    expect(new Uint8Array(readFileSync(join(workDir, "played.bin")))).toEqual(media);

    // An item of an encrypted view plays the same, by its position in the view.
    const created = await run("-X", "POST", `${link}/views`);
    const view = JSON.parse(new TextDecoder().decode(created.out)) as { url: string };
    const fromView = await run(
      "play",
      "--player",
      "bun",
      `${view.url}/1`,
      "--",
      "player.mjs",
      "from-view.bin",
    );
    expect(fromView.code).toBe(0);
    expect(new Uint8Array(readFileSync(join(workDir, "from-view.bin")))).toEqual(media);

    // A player reads many times: an item deleted once read is refused, and kept.
    expect((await run("-H", "burn:1", "-d", "once", `${link}/new`)).code).toBe(0);
    const refused = await run("play", "--player", "bun", `${link}/1`);
    expect(refused.code).toBe(1);
    expect(refused.error).toContain("deleted once read");
    expect(new TextDecoder().decode((await run(`${link}/1`)).out)).toBe("once");
    rmSync(workDir, { recursive: true, force: true });
    await own.stop();
  });

  test("push needs a whole VAPID key pair; a wrong one turns push off, not the site", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const VAPID_PUBLIC_KEY = toBase64Url(
      new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
    );
    const VAPID_PRIVATE_KEY = defined(
      (await crypto.subtle.exportKey("jwk", pair.privateKey)).d,
      "d",
    );
    expect(loadConfig({}).push).toBeNull();
    expect(loadConfig({}).maxPushSubscriptions).toBe(20);
    expect(loadConfig({ MAX_PUSH_SUBSCRIPTIONS: "5" }).maxPushSubscriptions).toBe(5);
    expect(loadConfig({ VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY }).push).toMatchObject({
      publicKey: VAPID_PUBLIC_KEY,
      subject: "https://github.com/merutam/kurobako",
    });
    // Pasted as ops/vapid.ts prints it, or quoted: taken all the same.
    expect(
      loadConfig({
        VAPID_PUBLIC_KEY: `"${VAPID_PUBLIC_KEY}"`,
        VAPID_PRIVATE_KEY: `VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}`,
      }).push,
    ).toMatchObject({ publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY });
    // On Workers a thrown setting fails every request: a wrong one only turns push off.
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const vars of [
        { VAPID_PUBLIC_KEY },
        { VAPID_PUBLIC_KEY: "7b12790cfd738a627dbecd1ee42e7972", VAPID_PRIVATE_KEY },
        { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: "short" },
        { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT: "ops@example.com" },
      ]) {
        expect(loadConfig(vars).push).toBeNull();
      }
    } finally {
      logged.mockRestore();
    }
    // What the log says: which key, and what it should look like, never the key.
    expect(vapidKeyProblem(VAPID_PUBLIC_KEY, "")).toContain("VAPID_PRIVATE_KEY is missing");
    const hex = vapidKeyProblem("7b12790cfd738a627dbecd1ee42e7972", VAPID_PRIVATE_KEY);
    expect(hex).toContain("VAPID_PUBLIC_KEY is not a VAPID public key (87");
    expect(hex).not.toContain("7b12790c");
    expect(vapidKeyProblem(VAPID_PUBLIC_KEY, "short")).toContain("VAPID_PRIVATE_KEY is not");
    expect(vapidKeyProblem(VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)).toBeNull();
  });

  test("pushes each send to the devices that asked, but the one it came from", async () => {
    // The server's VAPID keys, as ops/vapid.ts makes them.
    const vapid = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const vapidPublic = new Uint8Array(
      (await crypto.subtle.exportKey("raw", vapid.publicKey)) as ArrayBuffer,
    );
    const own = await startServer({
      config: {
        ...config,
        sendsPerMinute: 1_000,
        // Small, to see the oldest go.
        maxPushSubscriptions: 2,
        push: {
          publicKey: toBase64Url(vapidPublic),
          privateKey: defined((await crypto.subtle.exportKey("jwk", vapid.privateKey)).d, "d"),
          subject: "mailto:ops@example.com",
        },
      },
      dataDir: mkdtempSync(join(tmpdir(), "kurobako-push-")),
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
    const site = own.server.url.origin;

    const realFetch = globalThis.fetch;
    const pushed: { endpoint: string; headers: Headers; body: Uint8Array<ArrayBuffer> }[] = [];
    let answer = 201;
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://fcm.googleapis.com/")) return realFetch(input, init);
      pushed.push({
        endpoint: url,
        headers: new Headers(init?.headers),
        body: new Uint8Array(await new Response(init?.body).arrayBuffer()),
      });
      return new Response(null, { status: answer });
    }) as typeof fetch);

    const device = async (id: string) => {
      const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ])) as CryptoKeyPair;
      const p256dh = new Uint8Array(
        (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer,
      );
      const auth = crypto.getRandomValues(new Uint8Array(16));
      const endpoint = `https://fcm.googleapis.com/fcm/send/${id}`;
      return {
        keys,
        p256dh,
        auth,
        endpoint,
        skip: await skipIdOf(endpoint),
        subscription: { endpoint, keys: { p256dh: toBase64Url(p256dh), auth: toBase64Url(auth) } },
      };
    };
    type Device = Awaited<ReturnType<typeof device>>;
    const open = async (to: Device, body: Uint8Array<ArrayBuffer>) => {
      type Bytes = Uint8Array<ArrayBuffer>;
      const hkdf = async (salt: Bytes, ikm: Bytes, info: Bytes, length: number) =>
        new Uint8Array(
          await crypto.subtle.deriveBits(
            { name: "HKDF", hash: "SHA-256", salt, info },
            await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
            length * 8,
          ),
        );
      const text = (value: string) => new Uint8Array(new TextEncoder().encode(value));
      const salt = body.slice(0, 16);
      const keyLength = defined(body[20], "key length");
      const serverKey = body.slice(21, 21 + keyLength);
      const shared = new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: "ECDH",
            public: await crypto.subtle.importKey(
              "raw",
              serverKey,
              { name: "ECDH", namedCurve: "P-256" },
              false,
              [],
            ),
          },
          to.keys.privateKey,
          256,
        ),
      );
      const info = new Uint8Array([...text("WebPush: info\0"), ...to.p256dh, ...serverKey]);
      const ikm = await hkdf(to.auth, shared, info, 32);
      const key = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
      const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonce },
          await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]),
          body.slice(21 + keyLength),
        ),
      );
      expect(plain.at(-1)).toBe(2);
      return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
    };
    /** Sends arrive after the answer. */
    const settled = async (count: number) => {
      for (let tries = 0; pushed.length < count && tries < 100; tries += 1) await Bun.sleep(20);
      await Bun.sleep(50);
      expect(pushed).toHaveLength(count);
    };
    const subscribe = (ns: string, body: unknown, query = "") =>
      realFetch(`${site}/${ns}/push${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const send = (ns: string, text: string, headers: Record<string, string> = {}) =>
      realFetch(`${site}/${ns}/new`, {
        method: "POST",
        body: text,
        headers: { "content-type": "text/plain", ...headers },
      });

    try {
      const ns = fresh();
      const phone = await device("phone");
      const laptop = await device("laptop");
      // Nothing to follow yet: subscribing creates no namespace.
      expect((await subscribe(ns, phone.subscription)).status).toBe(404);
      await send(ns, "first");
      expect((await subscribe(ns, phone.subscription)).status).toBe(201);
      expect((await subscribe(ns, laptop.subscription)).status).toBe(201);
      // Only push services: anything else would have the server post anywhere.
      const elsewhere = { ...phone.subscription, endpoint: "https://example.com/hook" };
      expect((await subscribe(ns, elsewhere)).status).toBe(400);
      expect((await subscribe(ns, { endpoint: phone.endpoint })).status).toBe(400);

      // Sent from the laptop: the phone is told, the laptop is not.
      const sent = (await (
        await send(ns, "  hello\n  phone ", { "push-skip": laptop.skip })
      ).json()) as Item;
      await settled(1);
      const [push] = pushed;
      expect(push?.endpoint).toBe(phone.endpoint);
      expect(push?.headers.get("content-encoding")).toBe("aes128gcm");
      expect(push?.headers.get("urgency")).toBe("high");
      expect(await open(phone, defined(push?.body, "push body"))).toEqual({
        space: "plain",
        name: ns,
        id: sent.id,
        kind: "text",
        preview: "hello phone",
      });
      // Signed with the server's key, for the push service's origin.
      const [, jwt, k] = defined(
        /^vapid t=([^,]+), k=(.+)$/.exec(push?.headers.get("authorization") ?? ""),
        "VAPID header",
      );
      const [header, claims, signature] = defined(jwt, "jwt").split(".");
      expect(k).toBe(toBase64Url(vapidPublic));
      expect(
        await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          vapid.publicKey,
          fromBase64Url(defined(signature, "signature")),
          new TextEncoder().encode(`${header}.${claims}`),
        ),
      ).toBe(true);
      expect(
        JSON.parse(new TextDecoder().decode(fromBase64Url(defined(claims, "claims")))),
      ).toMatchObject({
        aud: "https://fcm.googleapis.com",
        sub: "mailto:ops@example.com",
      });

      // Read once: no preview. And a push service that forgot a device: it goes.
      answer = 410;
      await send(ns, "once", { burn: "1" });
      await settled(3);
      const burned = pushed.slice(1).find((each) => each.endpoint === phone.endpoint);
      expect(await open(phone, defined(burned?.body, "burn push"))).not.toHaveProperty("preview");
      answer = 201;
      await send(ns, "after the browsers forgot");
      await Bun.sleep(150);
      expect(pushed).toHaveLength(3);

      // Turned off: nothing more, and subscribing again works.
      expect((await subscribe(ns, phone.subscription)).status).toBe(201);
      expect((await subscribe(ns, { endpoint: phone.endpoint }, "?off")).status).toBe(200);
      await send(ns, "nobody listens");
      await Bun.sleep(150);
      expect(pushed).toHaveLength(3);

      // Past MAX_PUSH_SUBSCRIPTIONS (2 here), the oldest goes.
      const first = await device("first");
      const second = await device("second");
      const third = await device("third");
      for (const each of [first, second, third]) {
        expect((await subscribe(ns, each.subscription)).status).toBe(201);
        await Bun.sleep(5);
      }
      await send(ns, "to the newest two");
      await settled(5);
      expect(
        pushed
          .slice(3)
          .map((each) => each.endpoint)
          .sort(),
      ).toEqual([second.endpoint, third.endpoint].sort());
    } finally {
      spy.mockRestore();
      await own.stop();
    }
  });

  test("k.mjs reports that namespace locks are retired", async () => {
    const script = join(import.meta.dir, "..", "..", "public", "k.mjs");
    const k = async (args: string[], env: Record<string, string> = {}) => {
      const child = Bun.spawn(["bun", script, ...args], {
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
    // A server of its own: the sends of the tests before have used up this address's.
    const own = await startServer({
      config: { ...config, sendsPerMinute: 1_000 },
      dataDir: mkdtempSync(join(tmpdir(), "kurobako-lock-")),
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
    const ns = `${own.server.url.origin}/${fresh()}`;
    const plainLock = await k(["-X", "POST", `${ns}/lock`]);
    expect(plainLock.code).toBe(1);
    expect(plainLock.error).toContain("Namespace locks are not part of this protocol.");
    expect((await k(["-d", "hello", `${ns}/new`])).code).toBe(0);
    expect((await k([`${ns}/1`])).out).toBe("hello");

    const sealed = `${own.server.url.origin}/e#${encodeURIComponent(`wall ${crypto.randomUUID()}`)}`;
    expect((await k(["-d", "first", `${sealed}/new`])).code).toBe(0);
    const sealedLock = await k(["-X", "POST", `${sealed}/lock`]);
    expect(sealedLock.code).toBe(1);
    expect(sealedLock.error).toContain("Namespace locks are not part of this protocol.");
    expect((await k(["-d", "second", `${sealed}/new`])).code).toBe(0);
    expect((await k([`${sealed}/1`])).out).toBe("second");
    await own.stop();
  });
});

/** k.mjs is a single file people download, so a few rules live in two places and must agree. */
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
