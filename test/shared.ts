// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
//
// Tests that hold on every platform: they only speak HTTP to the server, and
// reach its storage through the harness. The Worker and the Bun server each
// run them with their own harness, next to their platform-specific tests.
import type { expect as vitestExpect } from "vitest";
import { openSealedSpace, openSharedItem } from "../public/k.mjs";
import type { AppConfig } from "../src/config";
import type { AccessLogEntry } from "../src/request-info";
import { defined, type FileItem, type Item, type SharedItem } from "./support";

export type Harness = {
  describe: (name: string, body: () => void) => void;
  test: (name: string, body: () => Promise<void>) => void;
  expect: typeof vitestExpect;
  /** Calls the server: a different client address each time unless cf-connecting-ip is set. */
  call: (path: string, init?: RequestInit) => Promise<Response>;
  /** The keys of the stored files under a prefix. */
  storedFiles: (prefix: string) => Promise<string[]>;
  config: AppConfig;
  /** The site's address, as absolute links show it. */
  origin: string;
  adminKey: string;
};

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const parse = async <T = unknown>(response: Response | Promise<Response>) =>
  (await response).json() as Promise<T>;
type PublicConfig = { namespace: { pattern: string; reserved: string[] } };

export const sharedTests = (harness: Harness) => {
  // The origin is read when a test runs: a server may only start before the tests.
  const { describe, test, expect, call, storedFiles, config, adminKey } = harness;
  const json = async <T = unknown>(path: string, init?: RequestInit) =>
    parse<T>(await call(path, init));
  const sendText = (namespace: string, text: string, headers: Record<string, string> = {}) =>
    call(`/${namespace}/new`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8", ...headers },
      body: text,
    });
  /** A share link, as the path to request it here: GET <ns>/<item>/s answers it as text. */
  const shareLink = async (path: string, init?: RequestInit) =>
    new URL((await (await call(path, init)).text()).trim()).pathname;
  /** Storage is shared between tests, so every test uses fresh namespaces. */
  const fresh = (prefix = "t") => `${prefix}${crypto.randomUUID().slice(0, 8)}`;
  const freshSealedId = () =>
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");

  describe("plain namespaces", () => {
    test("stores and returns text inside the namespace", async () => {
      const ns = fresh();
      expect((await sendText(ns, "café from the phone")).status).toBe(201);
      expect(await (await call(`/${ns}/1`)).text()).toBe("café from the phone");
    });

    test("takes what curl sends by hand", async () => {
      const ns = fresh();
      // curl -d "typed text" <site>/<ns>/new
      const typed = await json(`/${ns}/new`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "typed text",
      });
      expect(typed).toMatchObject({ kind: "text", text: "typed text" });
      // curl -T photo.png <site>/<ns>/
      const put = await json<FileItem>(`/${ns}/${encodeURIComponent("my photo.png")}`, {
        method: "PUT",
        body: png,
      });
      expect(put).toMatchObject({ kind: "image", filename: "my photo.png" });

      // Items by position, 1 being the newest: contents, download, share, delete.
      expect(await (await call(`/${ns}/2`)).text()).toBe("typed text");
      expect((await call(`/${ns}/3`)).status).toBe(404);
      // GET or POST, by position or ID: the same link.
      const shared = await shareLink(`/${ns}/1/s`);
      expect(shared).toMatch(/^\/i\/[A-Za-z0-9_-]{14}$/);
      expect(await shareLink(`/${ns}/${put.id}/s`, { method: "POST" })).toBe(shared);
      expect(new Uint8Array(await (await call(`/${ns}/1`)).arrayBuffer())).toEqual(png);
      expect((await call(`/${ns}/1/d`)).headers.get("content-disposition")).toContain(
        "my photo.png",
      );
      expect((await call(`/${ns}/1`, { method: "DELETE" })).status).toBe(200);
      expect(await (await call(`/${ns}/1`)).text()).toBe("typed text");
      expect((await call(`/${fresh()}/1`)).status).toBe(404);

      // A text downloads under its name (its start, by default); a
      // burn-after-reading one, which has none, under its ID.
      await sendText(ns, "named");
      expect((await call(`/${ns}/1/d`)).headers.get("content-disposition")).toContain(
        'filename="named.txt"',
      );
      const burning = await await parse<Item>(sendText(ns, "hidden", { burn: "1" }));
      expect((await call(`/${ns}/1/d`)).headers.get("content-disposition")).toContain(
        `filename="text-${burning.id}.txt"`,
      );
      expect((await call(`/${ns}/1`)).headers.get("content-disposition")).toBeNull();
    });

    test("describes one item as JSON, with a link to share it", async () => {
      const ns = fresh();
      const first = await await parse<Item>(sendText(ns, "first"));
      await sendText(ns, "hidden", { burn: "1" });

      type Described = Item & { position: number; shareUrl: string };
      const byPosition = await json<Described>(`/${ns}/2.json`);
      expect(byPosition).toMatchObject({ id: first.id, position: 2, text: "first" });
      expect(byPosition.shareUrl.startsWith(`${harness.origin}/i/`)).toBe(true);
      expect(byPosition.shareUrl).toMatch(/\/i\/[A-Za-z0-9_-]{14}$/);
      // The same link every time, and the same one …/s gives.
      expect((await json<Described>(`/${ns}/${first.id}.json`)).shareUrl).toBe(byPosition.shareUrl);
      expect(await (await call(`/${ns}/2/s`)).text()).toBe(`${byPosition.shareUrl}\n`);

      // Describing a burn-after-reading item reads nothing.
      const burning = await json<Described>(`/${ns}/1.json`);
      expect(burning).toMatchObject({ position: 1, burn: true });
      expect(burning.text).toBeUndefined();
      expect(await (await call(`/${ns}/1`)).text()).toBe("hidden");
      expect((await call(`/${ns}/9.json`)).status).toBe(404);
    });

    test("gives items short IDs, unique in their namespace, apart from positions", async () => {
      const ns = fresh();
      const ids = new Set<string>();
      for (let index = 0; index < 5; index += 1)
        ids.add((await await parse<Item>(sendText(ns, `n${index}`))).id);
      expect(ids.size).toBe(5);
      for (const id of ids) expect(id).toMatch(/^[a-z]{6}$/);
      const [newest] = [...ids].reverse();
      expect(await (await call(`/${ns}/${newest}`)).text()).toBe("n4");
      expect(await (await call(`/${ns}/1`)).text()).toBe("n4");
    });

    test("treats a trailing slash as no slash", async () => {
      const ns = fresh();
      await sendText(ns, "slash");
      expect((await call(`/${ns}/`)).status).toBe(200);
      expect(await json<Item[]>(`/${ns}/ls/`)).toHaveLength(1);
      expect(await (await call(`/${ns}/1/`)).text()).toBe("slash");
      // curl -T photo.png https://site/<ns> sends no name: X-Filename, or "file".
      const unnamed = await json<FileItem>(`/${ns}`, { method: "PUT", body: png });
      expect(unnamed).toMatchObject({ kind: "image", filename: "file.png" });
      // Other contents: the same ones would just move to the top.
      const named = await json<FileItem>(`/${ns}`, {
        method: "PUT",
        headers: { "x-filename": "madoka.png" },
        body: new Uint8Array([...png, 1]),
      });
      expect(named.filename).toBe("madoka.png");
    });

    test("moves the same contents to the top instead of storing them twice", async () => {
      const ns = fresh();
      const first = await sendText(ns, "same");
      expect(first.status).toBe(201);
      const original = await parse<Item>(first);
      await sendText(ns, "other");
      const url = await shareLink(`/${ns}/2/s`);

      const again = await sendText(ns, "same");
      expect(again.status).toBe(200);
      expect(await parse<Item & { existing: boolean }>(again)).toMatchObject({
        id: original.id,
        existing: true,
      });
      const items = await json<Item[]>(`/${ns}/ls`);
      expect(items.map((item) => item.text)).toEqual(["same", "other"]);
      expect(JSON.stringify(items)).not.toContain("sha256");
      // Same ID, so its share link still opens it.
      expect(await (await call(`${url}/c`)).text()).toBe("same");

      // Files too: one stored copy.
      const file = await call(`/${ns}/new`, { method: "POST", body: png });
      const fileAgain = await call(`/${ns}/new`, { method: "POST", body: png });
      expect([file.status, fileAgain.status]).toEqual([201, 200]);
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(1);

      // Sent again under another name, the item takes it; with no name, it keeps its own.
      const renamed = await json<FileItem>(`/${ns}/new`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-filename": "renamed.png" },
        body: png,
      });
      expect(renamed).toMatchObject({ filename: "renamed.png", existing: true });
      const unnamed = await json<FileItem>(`/${ns}`, { method: "PUT", body: png });
      expect(unnamed.filename).toBe("renamed.png");

      // Burn-after-reading items are always separate.
      await sendText(ns, "same", { burn: "1" });
      await sendText(ns, "same", { burn: "1" });
      expect(await json<Item[]>(`/${ns}/ls`)).toHaveLength(5);
    });

    test("renames items", async () => {
      const ns = fresh();
      const rename = (item: string, name: string) =>
        call(`/${ns}/${item}/n`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: name,
        });

      // A text takes a name, used in lists and downloads; an empty one restores the default.
      await sendText(ns, "some long text");
      expect(await (await rename("1", "  Notes   for later ")).json()).toMatchObject({
        name: "Notes for later",
      });
      expect((await json<Item[]>(`/${ns}/ls?summary`))[0]).toMatchObject({
        name: "Notes for later",
      });
      expect((await call(`/${ns}/1/d`)).headers.get("content-disposition")).toContain(
        'filename="Notes for later.txt"',
      );
      const cleared = await await parse<Item & { name?: string }>(rename("1", ""));
      expect(cleared.name).toBe("some long text");

      // An image keeps the extension of its real type; a file gets a clean name.
      const image = await json<FileItem>(`/${ns}/new`, { method: "POST", body: png });
      expect((await await parse<FileItem>(rename(image.id, "holiday.jpg"))).filename).toBe(
        "holiday.png",
      );
      await call(`/${ns}/new`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "data",
      });
      expect((await await parse<FileItem>(rename("1", "../report:v2.pdf"))).filename).toBe(
        "report-v2.pdf",
      );
      expect((await rename("1", " ")).status).toBe(400);
      expect((await rename("9", "x")).status).toBe(404);

      // An encrypted item takes new metadata under the same wrapped key, nothing else.
      const id = freshSealedId();
      const sealed = await json<Item>(`/e/${id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": "a2V5.bWV0YQ" },
        body: new Uint8Array([1, 2, 3]),
      });
      const reseal = (metadata: string) =>
        call(`/e/${id}/${sealed.id}/n`, {
          method: "POST",
          headers: { "x-sealed-metadata": metadata },
        });
      expect((await await parse<Item>(reseal("a2V5.bmV3"))).metadata).toBe("a2V5.bmV3");
      expect((await reseal("b3RoZXI.bmV3")).status).toBe(400);
    });

    test("finds items by position, ID or name", async () => {
      const ns = fresh();
      const upload = (name: string, body: string) =>
        json<FileItem>(`/${ns}/new`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "x-filename": name },
          body,
        });
      const report = await upload("report.pdf", "first pdf");
      await upload("data.json", "{}");
      await upload("data", "plain data");
      await sendText(ns, "a note");
      await call(`/${ns}/1/n`, { method: "POST", body: "my note" });

      expect(await (await call(`/${ns}/report.pdf`)).text()).toBe("first pdf");
      expect(await (await call(`/${ns}/${report.id}`)).text()).toBe("first pdf");
      expect(await (await call(`/${ns}/my%20note`)).text()).toBe("a note");
      expect((await call(`/${ns}/report.pdf/d`)).headers.get("content-disposition")).toContain(
        "report.pdf",
      );
      // .json is the item's JSON, unless an item has exactly that name.
      expect(await json<FileItem & { position: number }>(`/${ns}/report.pdf.json`)).toMatchObject({
        id: report.id,
        position: 4,
      });
      expect(await (await call(`/${ns}/data.json`)).text()).toBe("{}");
      // The fixed paths always win, and the newest item of a name is the one found.
      expect(await json<Item[]>(`/${ns}/ls`)).toHaveLength(4);
      await upload("report.pdf", "second pdf");
      expect(await (await call(`/${ns}/report.pdf`)).text()).toBe("second pdf");
      expect((await call(`/${ns}/report.pdf`, { method: "DELETE" })).status).toBe(200);
      expect(await (await call(`/${ns}/report.pdf`)).text()).toBe("first pdf");
      expect((await call(`/${ns}/missing.txt`)).status).toBe(404);
    });

    test("names texts by their start, and finds items by the start of a name", async () => {
      const ns = fresh();
      const long = `Shopping list for the weekend: ${"rice, beans, coffee, ".repeat(5)}`;
      const text = await await parse<Item & { name: string }>(sendText(ns, long));
      expect(text.name).toBe(
        "Shopping list for the weekend: rice, beans, coffee, rice, beans, coffee, rice",
      );
      expect(await (await call(`/${ns}/shopping`)).text()).toBe(long);
      await json(`/${ns}/new`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-filename": "Report 2024.pdf" },
        body: "pdf",
      });
      expect(await (await call(`/${ns}/report`)).text()).toBe("pdf");
      // A burn-after-reading text has no name: its start would give it away.
      const secret = await await parse<Item & { name?: string }>(
        sendText(ns, "secret words", { burn: "1" }),
      );
      expect(secret.name).toBeUndefined();
      expect((await call(`/${ns}/secret`)).status).toBe(404);
    });

    test("keeps namespaces apart", async () => {
      const [alpha, beta] = [fresh(), fresh()];
      await sendText(alpha, "one");
      await sendText(beta, "two");
      expect((await json<Item[]>(`/${alpha}/ls`)).map((item) => item.text)).toEqual(["one"]);
      expect((await json<Item[]>(`/${beta}/ls`)).map((item) => item.text)).toEqual(["two"]);
    });

    test("detects images by their bytes and stores other files as downloads", async () => {
      const ns = fresh();
      const image = await json<FileItem>(`/${ns}/new`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": encodeURIComponent("foto.svg"),
        },
        body: png,
      });
      expect(image).toMatchObject({ kind: "image", mime: "image/png", filename: "foto.png" });
      const preview = await call(`/${ns}/${image.id}`);
      expect(preview.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await preview.arrayBuffer())).toEqual(png);

      const file = await json<FileItem>(`/${ns}/new`, {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "x-filename": encodeURIComponent("notas<script>.html"),
        },
        body: "not an image",
      });
      expect(file).toMatchObject({
        kind: "file",
        mime: "application/octet-stream",
        filename: "notas-script-.html",
      });
      expect((await call(`/${ns}/${file.id}`)).headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      const download = await call(`/${ns}/${file.id}/d`);
      expect(download.headers.get("content-disposition")).toMatch(/^attachment/);
      expect(download.headers.get("content-security-policy")).toContain("sandbox");
    });

    test("keeps file names safe on every system", async () => {
      const ns = fresh();
      const named = async (filename: string) =>
        (
          await json<FileItem>(`/${ns}/new`, {
            method: "POST",
            headers: {
              "content-type": "application/octet-stream",
              "x-filename": encodeURIComponent(filename),
            },
            // Different contents each time, or the same item would come back.
            body: filename,
          })
        ).filename;
      expect(await named("../../etc/passwd")).toBe("passwd");
      expect(await named("CON.txt")).toBe("_CON.txt");
      expect(await named("-rf.sh")).toBe("_-rf.sh");
      expect(await named('a:b*c?"d<e>f|g.txt')).toBe("a-b-c-d-e-f-g.txt");
      expect(await named("\u0000\u0007.hidden")).toBe("file.hidden");
    });

    test("names downloads for every client, accents included", async () => {
      const ns = fresh();
      const file = await json<FileItem>(`/${ns}/new`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": encodeURIComponent("relatório ação.pdf"),
        },
        body: "pdf",
      });
      const disposition = (await call(`/${ns}/${file.id}/d`)).headers.get("content-disposition");
      // curl -J and older clients read filename; browsers prefer filename*.
      expect(disposition).toBe(
        `attachment; filename="relatorio acao.pdf"; filename*=UTF-8''relat%C3%B3rio%20a%C3%A7%C3%A3o.pdf`,
      );
    });

    test("keeps the newest items and deletes evicted files from R2", async () => {
      const ns = fresh();
      const { maxItems } = config;
      const first = await json<Item>(`/${ns}/new`, { method: "POST", body: png });
      for (let index = 0; index < maxItems; index += 1) await sendText(ns, `item ${index}`);

      const items = await json<Item[]>(`/${ns}/ls`);
      expect(items).toHaveLength(maxItems);
      expect(items.some((item) => item.id === first.id)).toBe(false);
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(0);
    });

    test("deletes a specific item and its file", async () => {
      const ns = fresh();
      const image = await json<FileItem>(`/${ns}/new`, { method: "POST", body: png });
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(1);
      expect((await call(`/${ns}/${image.id}`, { method: "DELETE" })).status).toBe(200);
      expect(await json<Item[]>(`/${ns}/ls`)).toEqual([]);
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(0);
    });

    test("rejects reserved and invalid names", async () => {
      for (const path of [
        "/i",
        "/e/zz/ls",
        "/Upper",
        "/Upper/ls",
        "/-x/ls",
        `/${fresh()}/not-an-id`,
      ]) {
        expect((await call(path)).status).toBe(404);
      }
    });
  });

  describe("send limit", () => {
    test("allows 30 sends a minute per address, then answers 429", async () => {
      const ns = fresh("limit");
      const ip = { "cf-connecting-ip": "192.0.2.199" };
      const statuses: number[] = [];
      for (let index = 0; index < 31; index += 1) {
        statuses.push((await sendText(ns, `item ${index}`, ip)).status);
      }
      expect(statuses.slice(0, 30).every((status) => status === 201)).toBe(true);
      const blocked = await sendText(ns, "one too many", ip);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("60");
      // Another address is not affected.
      expect(
        (await sendText(ns, "someone else", { "cf-connecting-ip": "192.0.2.200" })).status,
      ).toBe(201);
    });
  });

  describe("access logs", () => {
    test("logs each namespace separately, with location", async () => {
      const [alpha, beta] = [fresh(), fresh()];
      await sendText(alpha, "first");
      await call(`/${alpha}/ls`, {
        headers: {
          "cf-connecting-ip": "203.0.113.42",
          "cf-ipcountry": "BR",
          "cf-region": "Minas Gerais",
          "cf-ipcity": "Itabirito",
          "user-agent": "Alpha Browser",
        },
      });
      await sendText(beta, "beta", { "cf-connecting-ip": "198.51.100.20" });

      const alphaLog = await (await call(`/${alpha}/log`)).text();
      expect(alphaLog).toContain("203.0.113.42");
      expect(alphaLog).toContain("Itabirito, Minas Gerais, BR");
      expect(alphaLog).not.toContain("198.51.100.20");
      expect((await call("/log.json")).status).toBe(404);
    });

    test("does not create namespaces for probes", async () => {
      const ns = fresh();
      await call(`/${ns}/ls`, { headers: { "cf-connecting-ip": "192.0.2.9" } });
      expect(await json<AccessLogEntry[]>(`/${ns}/log.json`)).toEqual([]);
    });
  });

  describe("encrypted namespaces", () => {
    test("store ciphertext apart from plain namespaces", async () => {
      const id = freshSealedId();
      const ciphertext = new Uint8Array([1, 2, 3, 4, 5]);
      expect((await call(`/e/${id}/new`, { method: "POST", body: ciphertext })).status).toBe(400);

      const item = await json<Item>(`/e/${id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": "a2V5.bWV0YQ" },
        body: ciphertext,
      });
      expect(item).toMatchObject({ kind: "sealed", metadata: "a2V5.bWV0YQ", size: 5 });
      expect(item).not.toHaveProperty("contentUrl");
      const content = await call(`/e/${id}/${item.id}`);
      expect(content.headers.get("content-type")).toBe("application/octet-stream");
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(ciphertext);
      // A plain namespace with a similar name holds nothing of it.
      const twin = id.toLowerCase().replace(/[^a-z0-9]/g, "0");
      expect(await json<Item[]>(`/${twin}/ls`)).toEqual([]);

      expect((await call(`/e/${id}/${item.id}`, { method: "DELETE" })).status).toBe(200);
      expect(await json<Item[]>(`/e/${id}/ls`)).toEqual([]);
    });

    test("round-trip through the API with the website's own encryption code", async () => {
      const space = await openSealedSpace(` round trip ${crypto.randomUUID()} `);
      const contents = new TextEncoder().encode("olá, só para quem tem o nome");
      const { header, body, keyText } = await space.sealItem(contents, {
        kind: "text",
        title: "greeting",
        size: contents.byteLength,
      });
      const item = await json<Item>(`/e/${space.id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": header },
        body,
      });

      // With the name: list, unwrap the item key, read.
      const listed = defined((await json<Item[]>(`/e/${space.id}/ls`))[0], "the item in the list");
      const opened = await space.openItem(listed.metadata, listed.size);
      expect(opened.metadata).toEqual({
        kind: "text",
        title: "greeting",
        size: contents.byteLength,
      });
      const sealed = await (await call(`/e/${space.id}/${listed.id}`)).arrayBuffer();
      expect(new TextDecoder().decode(await opened.open(sealed))).toBe(
        "olá, só para quem tem o nome",
      );
      expect(opened.keyText).toBe(keyText);

      // With only a share link's key: the same item, and nothing else.
      const url = await shareLink(`/e/${space.id}/${item.id}/s`);
      const shared = await json<SharedItem>(`${url}.json`);
      const fromLink = await openSharedItem(keyText, shared.metadata, shared.size);
      const linked = await (await call(`${url}/c`)).arrayBuffer();
      expect(new TextDecoder().decode(await fromLink.open(linked))).toBe(
        "olá, só para quem tem o nome",
      );
      await expect(
        openSharedItem(
          keyText.replace(/^./, (c) => (c === "A" ? "B" : "A")),
          shared.metadata,
          shared.size,
        ),
      ).rejects.toThrow();
    });

    test("serve the page, refuse bad IDs and log without a way back", async () => {
      expect(await (await call("/e")).text()).toContain("<html");
      expect((await call("/e/kk/ls")).status).toBe(404);
      const id = freshSealedId();
      await call(`/e/${id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": "a2V5.eA", "cf-connecting-ip": "203.0.113.7" },
        body: "x",
      });
      const log = await (await call(`/e/${id}/log`)).text();
      expect(log).toContain("203.0.113.7");
      expect(log).toContain("encrypted namespace");
      expect(log).not.toContain(">Back<");
    });
  });

  describe("burn after reading", () => {
    test("hides a text until its first read, then deletes it", async () => {
      const ns = fresh();
      const item = await await parse<Item>(sendText(ns, "secret", { burn: "1" }));
      expect(item).toMatchObject({ kind: "text", burn: true });
      expect(JSON.stringify(await json<Item[]>(`/${ns}/ls`))).not.toContain("secret");

      expect(await (await call(`/${ns}/${item.id}`)).text()).toBe("secret");
      expect((await call(`/${ns}/${item.id}`)).status).toBe(404);
      expect(await json<Item[]>(`/${ns}/ls`)).toEqual([]);
    });

    test("applies to files, the latest-item route and encrypted items", async () => {
      const ns = fresh();
      const file = await json<FileItem>(`/${ns}/new`, {
        method: "POST",
        headers: { "x-filename": "a.txt", burn: "true" },
        body: "contents",
      });
      expect((await call(`/${ns}/${file.id}`)).status).toBe(200);
      expect((await call(`/${ns}/${file.id}`)).status).toBe(404);
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(0);

      await sendText(ns, "latest", { burn: "1" });
      expect(await (await call(`/${ns}/1`)).text()).toBe("latest");
      expect((await call(`/${ns}/1`)).status).toBe(404);

      const id = freshSealedId();
      const sealed = await json<Item>(`/e/${id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": "a2V5.bWV0YQ", burn: "1" },
        body: new Uint8Array([9, 9]),
      });
      expect((await call(`/e/${id}/${sealed.id}`)).status).toBe(200);
      expect((await call(`/e/${id}/${sealed.id}`)).status).toBe(404);
    });
  });

  describe("files in R2", () => {
    test("only one of two simultaneous reads gets a burn-after-reading file", async () => {
      const ns = fresh();
      const file = await json<FileItem>(`/${ns}/new`, {
        method: "POST",
        headers: { burn: "1" },
        body: png,
      });
      const responses = await Promise.all([call(`/${ns}/${file.id}`), call(`/${ns}/${file.id}`)]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
      const winner = defined(
        responses.find((response) => response.status === 200),
        "one successful read",
      );
      expect(new Uint8Array(await winner.arrayBuffer())).toEqual(png);
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(0);
    });

    test("streams a multi-chunk file through unchanged", async () => {
      const ns = fresh();
      const big = new Uint8Array(3_000_000);
      for (let offset = 0; offset < big.length; offset += 65_536) {
        crypto.getRandomValues(big.subarray(offset, offset + 65_536));
      }
      big.set(png);
      const stream = new Blob([big]).stream();
      const item = await json<FileItem>(`/${ns}/new`, {
        method: "POST",
        headers: { "content-length": String(big.byteLength), "x-filename": "big.png" },
        body: stream,
      });
      expect(item).toMatchObject({ kind: "image", size: big.byteLength });
      const download = new Uint8Array(await (await call(`/${ns}/${item.id}/d`)).arrayBuffer());
      expect(download.byteLength).toBe(big.byteLength);
      expect(download.every((byte, index) => byte === big[index])).toBe(true);
    });
  });

  /** The item a share page carries in its #item-data script. */
  const embeddedItem = (page: string) =>
    JSON.parse(
      defined(
        page.match(/<script type="application\/json" id="item-data">(.*?)<\/script>/s)?.[1],
        "the embedded item",
      ),
    );

  describe("share links", () => {
    const share = (path: string, id: string) => shareLink(`${path}/${id}/s`, { method: "POST" });

    test("open one item without revealing its namespace", async () => {
      const ns = fresh("share");
      const text = await await parse<Item>(sendText(ns, "just this one"));
      await sendText(ns, "not this one");

      const url = await share(`/${ns}`, text.id);
      expect(url).toMatch(/^\/i\/[A-Za-z0-9_-]{14}$/);
      expect(await share(`/${ns}`, text.id)).toBe(url);

      const page = await (await call(url)).text();
      const item = await json<SharedItem>(`${url}.json`, {
        headers: { "cf-connecting-ip": "198.51.100.33" },
      });
      // The page carries the item itself, so it needs no request of its own.
      expect(embeddedItem(page)).toEqual(item);
      expect(item).toMatchObject({ kind: "text", text: "just this one" });
      expect(item).not.toHaveProperty("id");
      for (const body of [page, JSON.stringify(item)]) {
        expect(body).not.toContain(ns);
        expect(body).not.toContain(text.id);
      }
      expect(await (await call(`${url}/c`)).text()).toBe("just this one");
      const disposition = (await call(`${url}/d`)).headers.get("content-disposition");
      expect(disposition).toContain('filename="just this one.txt"');
      expect(disposition).not.toContain(text.id);

      // The owner sees the visit.
      expect(JSON.stringify(await json<AccessLogEntry[]>(`/${ns}/log.json`))).toContain(
        "198.51.100.33",
      );
    });

    test("embed the item exactly as sent", async () => {
      const ns = fresh("share");
      const tricky = "$& $1 $' </script><b>";
      const text = await await parse<Item>(sendText(ns, tricky));
      const page = await (await call(await share(`/${ns}`, text.id))).text();
      expect(embeddedItem(page).text).toBe(tricky);
      expect(page).not.toContain("</script><b>");
    });

    test("serve images and files, and die with their item", async () => {
      const ns = fresh("share");
      const image = await json<FileItem>(`/${ns}/new`, { method: "POST", body: png });
      const url = await share(`/${ns}`, image.id);
      const shared = await json<SharedItem>(`${url}.json`);
      expect(shared).toMatchObject({
        kind: "image",
      });
      expect(new Uint8Array(await (await call(`${url}/c`)).arrayBuffer())).toEqual(png);

      await call(`/${ns}/${image.id}`, { method: "DELETE" });
      const gone = await call(url);
      expect(gone.status).toBe(404);
      expect(embeddedItem(await gone.text())).toBeNull();
      expect((await call(`${url}.json`)).status).toBe(404);
      expect((await call(`${url}/c`)).status).toBe(404);
      expect((await call("/i/not-a-token")).status).toBe(404);
    });

    test("consume burn-after-reading items through the link", async () => {
      const ns = fresh("share");
      const secret = await await parse<Item>(sendText(ns, "once", { burn: "1" }));
      const url = await share(`/${ns}`, secret.id);
      const shared = await json<SharedItem>(`${url}.json`);
      expect(shared).toMatchObject({ kind: "text", burn: true });
      expect(shared.text).toBeUndefined();
      expect(await (await call(`${url}/c`)).text()).toBe("once");
      expect((await call(`${url}/c`)).status).toBe(404);
      expect(await json<Item[]>(`/${ns}/ls`)).toEqual([]);
    });

    test("work for encrypted items, which only carry ciphertext", async () => {
      const id = freshSealedId();
      const item = await json<Item>(`/e/${id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": "a2V5.bWV0YQ" },
        body: new Uint8Array([7, 7, 7]),
      });
      const url = await share(`/e/${id}`, item.id);
      const shared = await json<SharedItem>(`${url}.json`);
      expect(shared).toMatchObject({
        kind: "sealed",
        metadata: "a2V5.bWV0YQ",
      });
      expect(JSON.stringify(shared)).not.toContain(id);
      expect(new Uint8Array(await (await call(`${url}/c`)).arrayBuffer())).toEqual(
        new Uint8Array([7, 7, 7]),
      );
    });
  });

  describe("lists", () => {
    test("send long texts as a preview in the page's list, whole in the API", async () => {
      const ns = fresh("long");
      const long = "word ".repeat(400);
      const item = await await parse<Item>(sendText(ns, long));

      const summary = defined((await json<Item[]>(`/${ns}/ls?summary`))[0], "the text");
      const preview = defined(summary.preview, "a preview");
      expect(summary.text).toBeUndefined();
      expect(preview.length).toBeLessThan(long.length);
      expect(long.startsWith(preview)).toBe(true);
      expect(await (await call(`/${ns}/${summary.id}`)).text()).toBe(long);
      // Not burn-after-reading: reading the whole text consumes nothing.
      expect(await json<Item[]>(`/${ns}/ls`)).toMatchObject([{ id: item.id, text: long }]);

      await sendText(ns, "short");
      const [shortSummary] = await json<Item[]>(`/${ns}/ls?summary`);
      expect(shortSummary?.text).toBe("short");
    });

    test("stores text above the inline threshold in object storage", async () => {
      const ns = fresh("external");
      const text = "external ".repeat(Math.ceil((config.inlineTextBytes + 1) / 9));
      const sent = await sendText(ns, text);
      expect(sent.status).toBe(201);
      const item = await parse<Item>(sent);
      expect(item).toMatchObject({ kind: "text", size: text.length });
      expect(item.text).toBeUndefined();
      expect(text.startsWith(defined(item.preview, "an external text preview"))).toBe(true);
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(1);

      const listed = defined((await json<Item[]>(`/${ns}/ls`))[0], "the external text");
      expect(listed.text).toBeUndefined();
      expect(await (await call(`/${ns}/${listed.id}`)).text()).toBe(text);
      expect((await call(`/${ns}/${listed.id}/d`)).headers.get("content-disposition")).toContain(
        ".txt",
      );

      // Deduplication keeps the original object and discards the just-uploaded copy.
      expect((await sendText(ns, text)).status).toBe(200);
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(1);
      expect((await call(`/${ns}/${item.id}`, { method: "DELETE" })).status).toBe(200);
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(0);

      const burnNamespace = fresh("externalburn");
      const burning = await parse<Item>(sendText(burnNamespace, `${text}!`, { burn: "1" }));
      expect(burning).toMatchObject({ kind: "text", burn: true });
      expect(burning.preview).toBeUndefined();
      expect(await storedFiles(`plain/${burnNamespace}/`)).toHaveLength(1);
      expect(await (await call(`/${burnNamespace}/${burning.id}`)).text()).toBe(`${text}!`);
      expect((await call(`/${burnNamespace}/${burning.id}`)).status).toBe(404);
      expect(await storedFiles(`plain/${burnNamespace}/`)).toHaveLength(0);
    });

    test("validates UTF-8 while an external text streams", async () => {
      const ns = fresh("utf8");
      const bytes = new Uint8Array(config.inlineTextBytes + 1).fill(0x61);
      bytes[bytes.length - 1] = 0xff;
      const response = await call(`/${ns}/new`, {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": String(bytes.length) },
        body: bytes,
      });
      expect(response.status).toBe(415);
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(0);
      expect(await json<Item[]>(`/${ns}/ls`)).toEqual([]);
    });
  });

  describe("live updates", () => {
    test("require a WebSocket upgrade", async () => {
      expect((await call(`/${fresh()}/live`)).status).toBe(426);
    });
  });

  describe("site", () => {
    test("assembles pages: versioned scripts, footer and the embedded config", async () => {
      const html = await (await call(`/${fresh()}`)).text();
      const version = html.match(/\/namespace\.js\?v=([0-9a-f]+)/)?.[1];
      expect(version).toBeDefined();
      expect(html).not.toContain("%APP_VERSION%");
      expect(html).not.toContain("%CONFIG%");
      expect(html).toContain(`(build ${version})`);

      const embedded = html.match(
        /<script type="application\/json" id="config">(.*?)<\/script>/s,
      )?.[1];
      expect(JSON.parse(defined(embedded, "the embedded config"))).toEqual(
        await json("/.well-known/kurobako"),
      );
    });

    test("exposes the public config the client needs", async () => {
      const body = await json<PublicConfig>("/.well-known/kurobako");
      expect(body).toMatchObject({
        base: "",
        version: expect.any(String),
        protocolUrl: "/k/protocol",
        clientUrl: "/k.mjs",
        maxItems: config.maxItems,
        sendsPerMinute: config.sendsPerMinute,
        inlineTextBytes: config.inlineTextBytes,
        live: { ping: "ping" },
      });
      expect(new RegExp(body.namespace.pattern).test("alpha")).toBe(true);
      expect(body.namespace.reserved).toEqual(["a", "e", "i", "k"]);
    });
  });

  describe("admin dashboard", () => {
    const login = (key: string, ip: string) =>
      call("/a/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ key }),
      });

    test("requires the key and locks out repeated failures", async () => {
      expect(await (await call("/a")).text()).toContain("<html");
      expect((await call("/a/overview")).status).toBe(401);

      const ip = "203.0.113.150";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login("wrong-key", ip)).status).toBe(401);
      }
      expect((await login(adminKey, ip)).status).toBe(429);

      const ok = await login(adminKey, "198.51.100.77");
      expect(ok.status).toBe(200);
      const cookie = defined(ok.headers.get("set-cookie"), "a session cookie");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
      const session = cookie.split(";", 1)[0] ?? "";
      expect((await call("/a/overview", { headers: { cookie: session } })).status).toBe(200);
      const forged = session.replace(/\.[^.]+$/, ".forged-signature");
      expect((await call("/a/overview", { headers: { cookie: forged } })).status).toBe(401);
    });
  });
};
