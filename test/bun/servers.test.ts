// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Several servers, slots, base paths and private instances.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newViewId } from "../../public/k.mjs";
import { STYLES } from "../../src/assets";
import {
  routeOf,
  SLOT_COUNT,
  slotOf,
  slotOwners,
  slotPrefix,
  tokenSlot,
} from "../../src/domain/routing";
import { startRouter } from "../../src/infrastructure/bun/router";
import { startServer } from "../../src/infrastructure/bun/server";
import { bundle } from "../../src/web/client/build";
import { TEST_ADMIN_KEY } from "../admin-key";
import { defined, type Item } from "../support";
import { config, fresh, memoryStore, nextMessage, png, useDefaultServer } from "./harness";

useDefaultServer();

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

  test("shared views route to their namespace's server", async () => {
    const ns = fresh();
    const item = await send(ns, "a view across servers");
    const created = (await (
      await via(`/${ns}/views`, {
        method: "POST",
        body: JSON.stringify({
          viewId: newViewId(),
          previousToken: null,
          entries: [{ id: item.id }],
        }),
      })
    ).json()) as { token: string; url: string };
    expect(tokenSlot(created.token)).toBe(slotOf({ space: "plain", name: ns }));
    const view = (await (await via(`${created.url}.json`)).json()) as { entries: { item: Item }[] };
    expect(view.entries[0]?.item.text).toBe("a view across servers");
  });

  test("relays live updates both ways", async () => {
    const ns = fresh();
    const socket = new WebSocket(`${front.replace("http", "ws")}/${ns}/live`);
    expect((await nextMessage(socket, "ready")).type).toBe("ready");
    const update = nextMessage(socket, "change");
    await send(ns, "live through the router");
    expect((await update).upserts[0]).toMatchObject({ text: "live through the router" });
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
      const response = await via(`/k/a/namespaces?server=${index + 1}&limit=500`, {
        headers: auth,
      });
      expect(response.headers.get("X-Kurobako-Server")).toBe(String(index + 1));
      expect(response.headers.get("X-Kurobako-Servers")).toBe("2");
      const { items } = (await response.json()) as { items: { name: string }[] };
      const listed = new Set(items.map((item) => item.name));
      for (const ns of names) expect(listed.has(ns)).toBe(nodeHolding(ns) === index);
    }
    // Out of range: the first server. Logged out: nothing said about the others.
    const outOfRange = await via("/k/a/overview?server=9", { headers: auth });
    expect(outOfRange.headers.get("X-Kurobako-Server")).toBe("1");
    expect((await via("/k/a/overview?server=2")).headers.get("X-Kurobako-Servers")).toBeNull();

    // Failed logins count on the first server, whichever one the page looks at.
    const wrong = { method: "POST", body: JSON.stringify({ key: "wrong" }) };
    for (let attempt = 0; attempt < 5; attempt += 1) await via("/k/a/login?server=2", wrong);
    expect((await via("/k/a/login", wrong)).status).toBe(429);
    const second = nodes[1]?.server.url.origin;
    const direct = await fetch(`${second}/k/a/login`, {
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
      "/k/a/overview",
      "/k/protocol",
      "/Notes",
    ]) {
      expect(routeOf(path)).toBeNull();
    }
  });
});

describe("under a base path", () => {
  const siteDir = mkdtempSync(join(tmpdir(), "kurobako-base-"));
  const workDir = mkdtempSync(join(tmpdir(), "kurobako-base-cli-"));
  let site: Awaited<ReturnType<typeof startServer>>;
  let origin = "";
  const at = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init);
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
    expect((await at("/k/k/licenses")).headers.get("content-type")).toContain("text/html");
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
    const html = await (await at("/k/notes")).text();
    const src = html.match(
      /<script type="module" src="(\/k\/k\/assets\/namespace-[0-9a-z]+\.js)"/,
    )?.[1];
    const script = await at(defined(src, "the namespace page's script"));
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(script.headers.get("cache-control")).toContain("immutable");
    // What it loads later is imported by relative paths, which stay under the path.
    const later = [...(await script.text()).matchAll(/import\("\.\/([^"]+\.js)"\)/g)];
    expect(later.length).toBeGreaterThan(0);
    for (const [, file] of later) {
      expect((await at(`/k/k/assets/${defined(file, "a later file")}`)).status).toBe(200);
    }
    expect((await at("/k/common.js")).status).toBe(404);
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
    const sharePath = new URL(described.shareUrl).pathname;
    expect(await (await at(`${sharePath}/ls`)).json()).toMatchObject([
      { kind: "text", text: "under k" },
    ]);
    expect(await (await at(sharePath)).text()).toContain(`href="${sharePath}/ls">As JSON</a>`);
    const view = (await (
      await at("/k/notes/views", {
        method: "POST",
        body: JSON.stringify({
          viewId: newViewId(),
          previousToken: null,
          entries: [{ id: sent.id }],
        }),
      })
    ).json()) as { url: string };
    expect(view.url).toStartWith("/k/v/");
    expect(await (await at(`${view.url}/ls`)).json()).toMatchObject([
      { kind: "text", text: "under k" },
    ]);
    expect(await (await at(view.url)).text()).toContain(`href="${view.url}/ls">As JSON</a>`);

    const socket = new WebSocket(`${origin.replace("http", "ws")}/k/notes/live`);
    const first = await nextMessage(socket, "ready");
    expect(first.type).toBe("ready");
    const listed = await at("/k/notes/ls");
    expect(((await listed.json()) as Item[])[0]?.id).toBe(sent.id);
    expect(Number(listed.headers.get("X-Queue-Revision"))).toBe(first.revision);
    socket.close();
  });

  test("k.mjs -O exports a plain namespace and overwrites local names", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kurobako-mirror-"));
    const script = join(import.meta.dir, "..", "..", "public", "k.mjs");
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
    // The admin is at /k/a inside the site, here under /k.
    const login = await at("/k/k/a/login", {
      method: "POST",
      body: JSON.stringify({ key: TEST_ADMIN_KEY }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/k/k/a");
    const cookie = setCookie.split(";")[0] ?? "";
    expect((await at("/k/k/a/overview", { headers: { cookie } })).status).toBe(200);
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

describe("a private instance", () => {
  const KEY = "a private key for tests";
  const dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), "kurobako-private-")));
  const workDir = mkdtempSync(join(tmpdir(), "kurobako-private-cli-"));
  let open: Awaited<ReturnType<typeof startServer>>;
  let closed: Awaited<ReturnType<typeof startServer>>;
  const bearer = { authorization: `Bearer ${KEY}` };
  const at = (path: string, init?: RequestInit) => fetch(`${open.server.url.origin}${path}`, init);
  const k = async (args: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "..", "public", "k.mjs"), ...args],
      {
        cwd: workDir,
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
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
    for (const path of [
      "/k/login",
      "/k/protocol",
      "/k/licenses",
      "/k/healthz",
      "/k.mjs",
      `/k/assets/${defined((await bundle()).manifest.files[STYLES], "styles").file}`,
    ]) {
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

    // Never to another site: an open redirect would make the login a phishing tool.
    const page = await (await at("/k/login?next=%2Fnotes%3Fx%3D1")).text();
    expect(page).toContain('name="next" value="/notes?x=1"');
    expect(page).not.toContain('type="module"');
    const posted = (key: string, next: string) =>
      at("/k/login", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ key, next }).toString(),
      });
    const wrong = await posted("nope", "/notes");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('name="next" value="/notes"');
    const right = await posted(KEY, "/notes?x=1");
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/notes?x=1");
    expect((await posted(KEY, "//elsewhere.example")).headers.get("location")).toBe("/");

    // Live updates too: the browser sends the session with the WebSocket.
    const origin = open.server.url.origin.replace("http", "ws");
    const socket = new WebSocket(`${origin}/notes/live`, { headers: { cookie } } as never);
    expect((await nextMessage(socket, "ready")).type).toBe("ready");
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
