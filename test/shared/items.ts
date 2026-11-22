// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { AccessLogEntry } from "../../src/domain/visits";
import { writeBundle } from "../../src/protocol/bundle.js";
import { defined, type FileItem, type Item, type SharedItem } from "../support";
import type { Harness } from "./index";
import { parse, png, type Tools } from "./tools";

export const itemsTests = (harness: Harness, tools: Tools) => {
  const { describe, test, expect, call, storedFiles, config } = harness;
  const { json, sendText, shareLink, fresh, freshSealedSpace, embeddedItem } = tools;
  describe("burn after reading", () => {
    test("counts reads atomically across namespace and share routes", async () => {
      const ns = fresh("reads");
      const sent = await sendText(ns, "three claims", { Reads: "3" });
      expect(sent.status).toBe(201);
      const item = (await sent.json()) as Item & { readsLeft?: number };
      expect(item.readsLeft).toBe(3);
      expect(item).not.toHaveProperty("text");
      expect(item).not.toHaveProperty("name");
      const link = await shareLink(`/${ns}/${item.id}/s`);
      expect((await json<Item & { readsLeft?: number }>(`${link}.json`)).readsLeft).toBe(3);
      const attempts = await Promise.all([
        call(`/${ns}/${item.id}/c`),
        call(`${link}/c`),
        call(`/${ns}/${item.id}/d`),
        call(`${link}/c`),
      ]);
      expect(attempts.filter((response) => response.status === 200)).toHaveLength(3);
      expect(attempts.filter((response) => response.status === 404)).toHaveLength(1);
      for (const response of attempts)
        if (response.status === 200) expect(await response.text()).toBe("three claims");
      expect((await call(`/${ns}/${item.id}`)).status).toBe(404);
      expect((await call(`${link}.json`)).status).toBe(404);
    });

    test("limited files ignore ranges and headers cannot disagree", async () => {
      const ns = fresh("readsfile");
      const file = await call(`/${ns}/limited.bin`, {
        method: "PUT",
        headers: { Reads: "2" },
        body: png,
      });
      expect(file.status).toBe(201);
      const item = (await file.json()) as Item & { readsLeft?: number };
      const first = await call(`/${ns}/${item.id}`, { headers: { Range: "bytes=0-1" } });
      expect(first.status).toBe(200);
      expect(first.headers.get("accept-ranges")).toBeNull();
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(png);
      expect((await json<Item & { readsLeft?: number }>(`/${ns}/${item.id}.json`)).readsLeft).toBe(
        1,
      );
      expect((await call(`/${ns}/${item.id}`, { headers: { Range: "bytes=0-1" } })).status).toBe(
        200,
      );
      expect((await call(`/${ns}/${item.id}`)).status).toBe(404);
      expect((await sendText(ns, "invalid", { Reads: "2", Burn: "1" })).status).toBe(400);
      for (const value of ["0", "-1", "1.5", "abc"]) {
        expect((await sendText(ns, "invalid", { Reads: value })).status).toBe(400);
      }
    });

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

      const space = await freshSealedSpace();
      const id = space.id;
      const sealed = await json<Item>(`/e/${id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": "a2V5.bWV0YQ", burn: "1", "write-key": space.writeKey },
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

    test("revalidates an unchanged file instead of sending it again", async () => {
      const ns = fresh();
      const bundle = (text: string) =>
        writeBundle({
          main: "notes.md",
          entries: [
            {
              path: "notes.md",
              type: "text/markdown",
              text: true,
              bytes: new TextEncoder().encode(text),
            },
          ],
        });
      const file = await json<FileItem>(`/${ns}/notes`, { method: "PUT", body: bundle("one") });
      const first = await call(`/${ns}/${file.id}`);
      expect(first.headers.get("cache-control")).toBe("private, no-cache");
      const etag = defined(first.headers.get("etag"), "an ETag");
      await first.arrayBuffer();

      const again = await call(`/${ns}/${file.id}`, { headers: { "if-none-match": etag } });
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);

      const edited = await parse<FileItem>(
        call(`/${ns}/${file.id}/e`, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "if-match": JSON.stringify(file.createdAt),
          },
          body: bundle("two"),
        }),
      );
      const changed = await call(`/${ns}/${edited.id}`, { headers: { "if-none-match": etag } });
      expect(changed.status).toBe(200);
      expect(changed.headers.get("etag")).not.toBe(etag);
      expect(new Uint8Array(await changed.arrayBuffer())).toEqual(bundle("two"));

      const limited = await json<FileItem>(`/${ns}/new`, {
        method: "POST",
        headers: { Reads: "2" },
        body: png,
      });
      const read = await call(`/${ns}/${limited.id}`, { headers: { "if-none-match": "*" } });
      expect(read.status).toBe(200);
      expect(read.headers.get("etag")).toBeNull();
      expect(read.headers.get("cache-control")).toBe("no-store");
      await read.arrayBuffer();
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
      expect(page).toContain(`href="${url}/ls">As JSON</a>`);
      expect(await json<Item[]>(`${url}/ls`)).toEqual([{ id: url.split("/").pop(), ...item }]);
      expect((await call(`${url}/ls?limit=0`)).status).toBe(400);
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
      expect(page).toContain("&lt;/script&gt;&lt;b&gt;");
      // As one open row of a list, readable before any script.
      expect(page).toContain('class="item open"');
    });

    test("renders a shared long text from blob storage in the first response", async () => {
      const ns = fresh("share");
      const long = "long text ".repeat(7_000);
      const item = await parse<Item>(sendText(ns, long));
      const page = await (await call(await share(`/${ns}`, item.id))).text();
      expect(page).toContain(`<pre>${long}</pre>`);
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
      expect((await call(`${url}/ls`)).status).toBe(404);
      expect((await call(`${url}/c`)).status).toBe(404);
      expect((await call("/i/not-a-token")).status).toBe(404);
    });

    test("consume burn-after-reading items through the link", async () => {
      const ns = fresh("share");
      const secret = await await parse<Item>(sendText(ns, "once", { burn: "1" }));
      const url = await share(`/${ns}`, secret.id);
      const page = await (await call(url)).text();
      expect(page).toContain('id="open-limited-item"');
      expect(page).not.toContain("<pre>once</pre>");
      const shared = await json<SharedItem>(`${url}.json`);
      expect(shared).toMatchObject({ kind: "text", burn: true });
      expect(shared.text).toBeUndefined();
      expect(await (await call(`${url}/c`)).text()).toBe("once");
      expect((await call(`${url}/c`)).status).toBe(404);
      expect(await json<Item[]>(`/${ns}/ls`)).toEqual([]);
    });

    test("work for encrypted items, which only carry ciphertext", async () => {
      const space = await freshSealedSpace();
      const id = space.id;
      const item = await json<Item>(`/e/${id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": "a2V5.bWV0YQ", "write-key": space.writeKey },
        body: new Uint8Array([7, 7, 7]),
      });
      const url = await shareLink(`/e/${id}/${item.id}/s`, {
        method: "POST",
        headers: { "write-key": space.writeKey },
      });
      const shared = await json<SharedItem>(`${url}.json`);
      expect(shared).toMatchObject({
        kind: "sealed",
        metadata: "a2V5.bWV0YQ",
      });
      const page = await (await call(url)).text();
      expect(page).toContain("Decrypting item…");
      expect(page).toContain('<main data-loading="">');
      expect(page).toContain('id="page-loading"');
      expect(JSON.stringify(shared)).not.toContain(id);
      expect(new Uint8Array(await (await call(`${url}/c`)).arrayBuffer())).toEqual(
        new Uint8Array([7, 7, 7]),
      );
      // Downloaded under the token, which the link already shows, never the item's ID.
      const token = url.split("/").pop();
      const disposition = (await call(`${url}/d`)).headers.get("content-disposition") ?? "";
      expect(disposition).toContain(`filename="${token}.sealed"`);
      expect(disposition).not.toContain(item.id);
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
};
