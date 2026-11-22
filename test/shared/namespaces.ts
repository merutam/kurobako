// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { openSealedSpace } from "../../public/k.mjs";
import { BUNDLE_MIME, readBundle, writeBundle } from "../../src/protocol/bundle.js";
import { describePlain, rowHash, rowState } from "../../src/web/client/shared/item-row.js";
import { defined, type FileItem, type Item } from "../support";
import type { Harness } from "./index";
import { parse, png, type Tools } from "./tools";

export const namespacesTests = (harness: Harness, tools: Tools) => {
  const { describe, test, expect, call, storedFiles, config } = harness;
  const { json, sendText, shareLink, fresh, freshSealedId, freshSealedSpace } = tools;
  test("limited-read texts cannot acquire a public name through rename", async () => {
    const ns = fresh();
    const sent = await sendText(ns, "hidden", { Reads: "2" });
    expect(sent.status).toBe(201);
    const reply = await call(`/${ns}/1/n`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "public",
    });
    expect(reply.status).toBe(400);
    expect(await json(`/${ns}/ls`)).not.toContainEqual(expect.objectContaining({ name: "public" }));
  });

  describe("retired namespace locks", () => {
    test("refuses locks in both spaces", async () => {
      const plain = fresh("lock");
      const sealed = freshSealedId();
      const attempts: Record<string, string>[] = [{}, { "write-key": "arbitrary" }];
      for (const path of [`/${plain}`, `/e/${sealed}`]) {
        for (const headers of attempts) {
          const response = await call(`${path}/lock`, { method: "POST", headers });
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual({
            error: "Namespace locks are not part of this protocol.",
          });
        }
        expect((await call(`${path}/ls`)).headers.get("locked")).toBeNull();
      }
    });

    test("refusing a lock does not prevent ordinary writes", async () => {
      const ns = fresh("lock");
      await sendText(ns, "someone's");
      expect((await call(`/${ns}/lock`, { method: "POST" })).status).toBe(503);
      expect((await sendText(ns, "still open")).status).toBe(201);
    });
  });

  describe("plain namespaces", () => {
    test("accepts a shorter expiry on each send and rejects invalid durations", async () => {
      const ns = fresh("expiry");
      const now = Date.now();
      const sent = await sendText(ns, "short-lived", { "Expires-In": "120" });
      expect(sent.status).toBe(201);
      const item = (await sent.json()) as Item;
      expect(Date.parse(item.expiresAt ?? "")).toBeGreaterThanOrEqual(now + 120_000);
      expect(Date.parse(item.expiresAt ?? "")).toBeLessThan(Date.now() + 121_000);
      const repeated = await sendText(ns, "short-lived", { "Expires-In": "60" });
      expect(repeated.status).toBe(200);
      expect((await repeated.json()) as Item).toMatchObject({ id: item.id });
      for (const value of ["0", "-1", "1.5", "abc", "999999999999999999999"]) {
        expect((await sendText(ns, "invalid", { "Expires-In": value })).status).toBe(400);
      }
    });

    test("stores and returns text inside the namespace", async () => {
      const ns = fresh();
      expect((await sendText(ns, "café from the phone")).status).toBe(201);
      expect(await (await call(`/${ns}/1`)).text()).toBe("café from the phone");
    });

    test("keeps a text's chosen filename through edits and downloads", async () => {
      const ns = fresh("named-text");
      const sent = await parse<Item>(
        sendText(ns, "const answer = 42", {
          "X-Text-Name": encodeURIComponent("Notes / code.js"),
        }),
      );
      expect(sent).toMatchObject({ kind: "text", name: "Notes - code.js" });
      expect((await call(`/${ns}/${sent.id}/d`)).headers.get("content-disposition")).toContain(
        'filename="Notes - code.js"',
      );
      const edited = await parse<Item>(
        call(`/${ns}/${sent.id}/e`, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "If-Match": JSON.stringify(sent.createdAt),
          },
          body: "const answer = 43",
        }),
      );
      expect(edited).toMatchObject({ name: "Notes - code.js" });
      expect((await call(`/${ns}/${sent.id}/d`)).headers.get("content-disposition")).toContain(
        'filename="Notes - code.js"',
      );
      const resent = await parse<Item>(
        sendText(ns, "const answer = 43", { "X-Text-Name": "renamed.js" }),
      );
      expect(resent).toMatchObject({ id: sent.id, name: "renamed.js", existing: true });
      expect((await sendText(ns, "secret", { Burn: "1", "X-Text-Name": "secret.js" })).status).toBe(
        400,
      );
      const long = "a".repeat(config.inlineTextBytes + 1);
      const external = await parse<Item>(sendText(ns, long, { "X-Text-Name": "large.rs" }));
      expect(external).toMatchObject({ name: "large.rs" });
      expect((await call(`/${ns}/${external.id}/d`)).headers.get("content-disposition")).toContain(
        'filename="large.rs"',
      );
    });

    test("keeps videos playable: their type, their extension, and parts of them", async () => {
      const ns = fresh();
      // An MP4's first box, then made-up contents.
      const mp4 = new Uint8Array(4096);
      mp4.set([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")]);
      for (let index = 12; index < mp4.length; index += 1) mp4[index] = index % 251;
      const sent = await json<FileItem>(`/${ns}/${encodeURIComponent("holiday.MOV")}`, {
        method: "PUT",
        body: mp4,
      });
      expect(sent).toMatchObject({ kind: "file", mime: "video/mp4", filename: "holiday.mp4" });

      const whole = await call(`/${ns}/1`);
      expect(whole.headers.get("content-type")).toBe("video/mp4");
      expect(whole.headers.get("accept-ranges")).toBe("bytes");
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(mp4);

      // What a player asks for to start, to seek and to read the end.
      for (const [range, offset, end] of [
        ["bytes=0-1", 0, 1],
        ["bytes=1000-1999", 1000, 1999],
        ["bytes=4000-", 4000, 4095],
        ["bytes=-96", 4000, 4095],
        ["bytes=4000-99999", 4000, 4095],
      ] as const) {
        const part = await call(`/${ns}/1`, { headers: { range } });
        expect(part.status).toBe(206);
        expect(part.headers.get("content-range")).toBe(`bytes ${offset}-${end}/4096`);
        expect(new Uint8Array(await part.arrayBuffer())).toEqual(mp4.slice(offset, end + 1));
      }
      const outside = await call(`/${ns}/1`, { headers: { range: "bytes=5000-" } });
      expect(outside.status).toBe(416);
      expect(outside.headers.get("content-range")).toBe("bytes */4096");
      await outside.body?.cancel();
      // Several ranges at once: the whole file.
      const several = await call(`/${ns}/1`, { headers: { range: "bytes=0-1,5-6" } });
      expect(several.status).toBe(200);
      await several.body?.cancel();

      // A burn-after-reading video is read whole, once, whatever is asked.
      await call(`/${ns}/once.mp4`, { method: "PUT", headers: { burn: "1" }, body: mp4 });
      const once = await call(`/${ns}/1`, { headers: { range: "bytes=0-1" } });
      expect(once.status).toBe(200);
      expect(once.headers.get("accept-ranges")).toBeNull();
      expect(new Uint8Array(await once.arrayBuffer())).toEqual(mp4);
    });

    test("keeps recognized audio playable and ranged", async () => {
      const ns = fresh("audio");
      const bytes = new Uint8Array([73, 68, 51, 4, 0, 0, ...Array(128).fill(0)]);
      const sent = await json<FileItem>(`/${ns}/song.bin`, { method: "PUT", body: bytes });
      expect(sent).toMatchObject({ kind: "file", mime: "audio/mpeg", filename: "song.mp3" });
      const part = await call(`/${ns}/${sent.id}`, { headers: { Range: "bytes=0-2" } });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-type")).toBe("audio/mpeg");
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(0, 3));
    });

    test("tells a bundle by its manifest and serves it as the tar it is", async () => {
      const ns = fresh("bundle");
      const encoder = new TextEncoder();
      const bytes = writeBundle({
        main: "notes.md",
        entries: [
          { path: "notes.md", type: "text/markdown", text: true, bytes: encoder.encode("# hi") },
          { path: "photo.png", type: "image/png", bytes: png },
        ],
      });
      // curl -T notes.tar <site>/<ns>/
      const sent = await json<FileItem>(`/${ns}/notes`, { method: "PUT", body: bytes });
      expect(sent).toMatchObject({ kind: "file", mime: BUNDLE_MIME, filename: "notes.tar" });
      const download = await call(`/${ns}/${sent.id}/d`);
      expect(download.headers.get("content-type")).toBe(BUNDLE_MIME);
      const back = readBundle(new Uint8Array(await download.arrayBuffer()));
      expect(back.main).toBe("notes.md");
      expect(
        back.entries.map((entry: { path: string; text: boolean }) => [entry.path, entry.text]),
      ).toEqual([
        ["notes.md", true],
        ["photo.png", false],
      ]);
      // Any other tar stays a plain download.
      const tar = new Uint8Array(1024);
      tar.set(encoder.encode("other.txt"), 0);
      const other = await json<FileItem>(`/${ns}/other.tar`, { method: "PUT", body: tar });
      expect(other.mime).toBe("application/octet-stream");
    });

    test("edits a bundle into another bundle, and nothing else into one", async () => {
      const ns = fresh("bundle-edit");
      const encoder = new TextEncoder();
      const bundle = (text: string) =>
        writeBundle({
          main: "notes.md",
          entries: [
            { path: "notes.md", type: "text/markdown", text: true, bytes: encoder.encode(text) },
            { path: "assets/photo.png", type: "image/png", bytes: png },
          ],
        });
      const edit = (item: Item, body: Uint8Array | string, headers: Record<string, string> = {}) =>
        call(`/${ns}/${item.id}/e`, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "if-match": JSON.stringify(item.updatedAt ?? item.createdAt),
            ...headers,
          },
          body,
        });

      const sent = await json<FileItem>(`/${ns}/notes`, { method: "PUT", body: bundle("# one") });
      const edited = await parse<FileItem>(
        edit(sent, bundle("# two"), { "x-filename": "renamed" }),
      );
      expect(edited).toMatchObject({
        id: sent.id,
        createdAt: sent.createdAt,
        mime: BUNDLE_MIME,
        filename: "renamed.tar",
      });
      const back = readBundle(
        new Uint8Array(await (await call(`/${ns}/${sent.id}`)).arrayBuffer()),
      );
      expect(new TextDecoder().decode(back.entries[0].bytes)).toBe("# two");
      // Without a name, it keeps its own.
      const again = await parse<FileItem>(edit(edited, bundle("# three")));
      expect(again.filename).toBe("renamed.tar");
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(1);

      // A stale version, a bundle into anything else, or a file into a bundle: refused.
      expect((await edit(sent, bundle("# lost"))).status).toBe(412);
      expect((await edit(again, png)).status).toBe(400);
      const text = await parse<Item>(sendText(ns, "a text"));
      expect((await edit(text, bundle("# no"))).status).toBe(400);
      const image = await parse<Item>(call(`/${ns}/new`, { method: "POST", body: png }));
      expect((await edit(image, bundle("# no"))).status).toBe(400);
    });

    test("lists only the newest items with ?limit", async () => {
      const ns = fresh("limit");
      for (const text of ["one", "two", "three"]) await sendText(ns, text);
      const top = await call(`/${ns}/ls?summary&limit=1`);
      expect(top.headers.get("x-queue-revision")).toBeTruthy();
      expect((await parse<Item[]>(top)).map((item) => item.text)).toEqual(["three"]);
      expect(await json<Item[]>(`/${ns}/ls?limit=2`)).toHaveLength(2);
      expect(await json<Item[]>(`/${ns}/ls?limit=50`)).toHaveLength(3);
      for (const bad of ["0", "-1", "two", "1.5"]) {
        expect((await call(`/${ns}/ls?limit=${bad}`)).status).toBe(400);
      }
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

    test("renders a plain namespace's initial queue without a loading screen", async () => {
      const ns = fresh();
      await sendText(ns, "visible on first paint");
      const page = await (await call(`/${ns}`)).text();
      expect(page).toContain("<main>");
      expect(page).not.toContain('id="page-loading"');
      expect(page).toContain(">visible on first paint</span>");
      // The browser keeps the server's row only if the hash of what it would make matches.
      const [item] = await json<Item[]>(`/${ns}/ls?summary`);
      const made = rowHash(rowState(item, describePlain(item), false, true));
      expect(page).toContain(`data-id="${defined(item, "the item").id}" data-made="${made}"`);
      // So the page fetches nothing to start.
      const listed = await call(`/${ns}/ls?summary`);
      const embedded = /<script type="application\/json" id="queue-data">(.*?)<\/script>/s.exec(
        page,
      )?.[1];
      expect(JSON.parse(defined(embedded, "the embedded queue"))).toEqual({
        items: await listed.json(),
        revision: Number(listed.headers.get("x-queue-revision")),
      });
      // Ready to use as it is: actions and icons included.
      expect(page).toContain('data-action="delete"');
      expect(page).toContain('class="item-kind">text</span>');
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

    test("a clone can preserve duplicate contents as separate new items", async () => {
      const ns = fresh("clone");
      const first = await parse<Item>(sendText(ns, "same", { "No-Dedup": "1" }));
      const second = await parse<Item>(sendText(ns, "same", { "No-Dedup": "1" }));
      expect(first.id).not.toBe(second.id);
      expect(await json<Item[]>(`/${ns}/ls`)).toHaveLength(2);
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
      const original = await parse<Item>(sendText(ns, "some long text"));
      const renamed = await parse<Item>(rename("1", "  Notes   for later "));
      expect(renamed).toMatchObject({
        name: "Notes for later",
        createdAt: original.createdAt,
      });
      expect(Date.parse(defined(renamed.updatedAt, "the rename time"))).toBeGreaterThanOrEqual(
        Date.parse(original.createdAt),
      );
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
      const space = await freshSealedSpace();
      const id = space.id;
      const sealed = await json<Item>(`/e/${id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": "a2V5.bWV0YQ", "write-key": space.writeKey },
        body: new Uint8Array([1, 2, 3]),
      });
      const reseal = (metadata: string, version = sealed.createdAt) =>
        call(`/e/${id}/${sealed.id}/n`, {
          method: "POST",
          headers: {
            "x-sealed-metadata": metadata,
            "if-match": JSON.stringify(version),
            "write-key": space.writeKey,
          },
        });
      const resealed = await parse<Item>(reseal("a2V5.bmV3"));
      expect(resealed.metadata).toBe("a2V5.bmV3");
      expect(resealed.updatedAt).toBeDefined();
      expect(
        (await reseal("b3RoZXI.bmV3", defined(resealed.updatedAt, "rename version"))).status,
      ).toBe(400);
      expect((await reseal("a2V5.bmV3")).status).toBe(412);
    });

    test("edits texts without changing their identity, and rejects stale edits", async () => {
      const ns = fresh();
      const edit = (item: Item, text: string, version = item.updatedAt ?? item.createdAt) =>
        call(`/${ns}/${item.id}/e`, {
          method: "POST",
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "if-match": JSON.stringify(version),
          },
          body: text,
        });

      const original = await parse<Item>(sendText(ns, "first draft"));
      const shared = await shareLink(`/${ns}/${original.id}/s`);
      const renamed = await parse<Item>(
        call(`/${ns}/${original.id}/n`, { method: "POST", body: "Notes" }),
      );
      const edited = await parse<Item>(edit(renamed, "second draft"));
      expect(edited).toMatchObject({
        id: original.id,
        createdAt: original.createdAt,
        expiresAt: original.expiresAt,
        name: "Notes",
        text: "second draft",
      });
      expect(Date.parse(defined(edited.updatedAt, "the edit time"))).toBeGreaterThan(
        Date.parse(defined(renamed.updatedAt, "the rename time")),
      );
      expect(await (await call(`${shared}/c`)).text()).toBe("second draft");

      const stale = await edit(renamed, "lost update");
      expect(stale.status).toBe(412);
      expect(await (await call(`/${ns}/${original.id}`)).text()).toBe("second draft");
      expect((await edit(edited, "bad", "not a date")).status).toBe(412);
      expect(
        (
          await call(`/${ns}/${original.id}/e`, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "missing precondition",
          })
        ).status,
      ).toBe(400);

      const file = await parse<Item>(call(`/${ns}/new`, { method: "POST", body: png }));
      expect((await edit(file, "not a file anymore")).status).toBe(400);
      const burn = await parse<Item>(sendText(ns, "once", { burn: "1" }));
      expect((await edit(burn, "twice")).status).toBe(400);
    });

    test("edits texts between inline and blob storage without leaking old blobs", async () => {
      const ns = fresh();
      const original = await parse<Item>(sendText(ns, "small"));
      const large = "external ".repeat(Math.ceil((config.inlineTextBytes + 1) / 9));
      const edit = (item: Item, text: string) =>
        call(`/${ns}/${item.id}/e`, {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            "if-match": JSON.stringify(item.updatedAt ?? item.createdAt),
          },
          body: text,
        });

      const external = await parse<Item>(edit(original, large));
      expect(external).toMatchObject({ id: original.id, preview: large.slice(0, 280) });
      expect(external).not.toHaveProperty("text");
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(1);

      const changed = `${large.slice(0, -1)}!`;
      const externalAgain = await parse<Item>(edit(external, changed));
      expect(await (await call(`/${ns}/${original.id}`)).text()).toBe(changed);
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(1);

      const inline = await parse<Item>(edit(externalAgain, "small again"));
      expect(inline).toMatchObject({ id: original.id, text: "small again", name: "small again" });
      expect(await storedFiles(`plain/${ns}/`)).toHaveLength(0);
    });

    test("edits encrypted texts under a new revision and the same item key", async () => {
      const space = await openSealedSpace(`edit ${crypto.randomUUID()}`);
      const first = new TextEncoder().encode("secret one");
      const sealed = await space.sealItem(first, {
        kind: "text",
        title: "secret one",
        size: first.byteLength,
      });
      const original = await json<Item>(`/e/${space.id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": sealed.header, "write-key": space.writeKey },
        body: sealed.body,
      });
      const opened = await space.openItem(
        defined(original.metadata, "sealed metadata"),
        original.size,
      );
      const second = new TextEncoder().encode("secret two");
      const replacement = await opened.withContents(second, { title: "secret two" });
      const competing = await opened.withContents(second);
      expect(replacement.metadata.rev).toBe(competing.metadata.rev);
      expect(replacement.metadata.bodyId).not.toBe(competing.metadata.bodyId);
      expect(replacement.body).not.toEqual(competing.body);
      const competingOpened = await space.openItem(competing.header, competing.body.byteLength);
      expect(new TextDecoder().decode(await competingOpened.open(competing.body))).toBe(
        "secret two",
      );
      const response = await call(`/e/${space.id}/${original.id}/e`, {
        method: "POST",
        headers: {
          "if-match": JSON.stringify(original.createdAt),
          "x-sealed-metadata": replacement.header,
          "write-key": space.writeKey,
        },
        body: replacement.body,
      });
      expect(response.status).toBe(200);
      const edited = (await response.json()) as Item;
      expect(edited).toMatchObject({ id: original.id, createdAt: original.createdAt });
      const reopened = await space.openItem(
        defined(edited.metadata, "edited metadata"),
        edited.size,
      );
      expect(reopened.keyText).toBe(opened.keyText);
      expect(reopened.metadata.rev).toBe(1);
      expect(reopened.metadata.bodyId).toBe(replacement.metadata.bodyId);
      const staleRename = await call(`/e/${space.id}/${original.id}/n`, {
        method: "POST",
        headers: {
          "if-match": JSON.stringify(original.createdAt),
          "x-sealed-metadata": await opened.withMetadata({ title: "outdated title" }),
          "write-key": space.writeKey,
        },
      });
      expect(staleRename.status).toBe(412);
      expect(
        new TextDecoder().decode(
          await reopened.open(await (await call(`/e/${space.id}/1`)).arrayBuffer()),
        ),
      ).toBe("secret two");
      expect(await storedFiles(`sealed/${space.id}/`)).toHaveLength(1);

      const stale = await call(`/e/${space.id}/${original.id}/e`, {
        method: "POST",
        headers: {
          "if-match": JSON.stringify(original.createdAt),
          "x-sealed-metadata": replacement.header,
          "write-key": space.writeKey,
        },
        body: replacement.body,
      });
      expect(stale.status).toBe(412);
      expect(await storedFiles(`sealed/${space.id}/`)).toHaveLength(1);

      const other = await space.sealItem(second, {
        kind: "text",
        title: "wrong key",
        size: second.byteLength,
      });
      const wrongKey = await call(`/e/${space.id}/${original.id}/e`, {
        method: "POST",
        headers: {
          "if-match": JSON.stringify(defined(edited.updatedAt, "the edit time")),
          "x-sealed-metadata": other.header,
          "write-key": space.writeKey,
        },
        body: other.body,
      });
      expect(wrongKey.status).toBe(400);
      expect(await storedFiles(`sealed/${space.id}/`)).toHaveLength(1);
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
      const withEmoji = `${"a".repeat(79)}😀and more`;
      const emojiText = await await parse<Item & { name: string }>(sendText(ns, withEmoji));
      expect(emojiText.name).toBe(`${"a".repeat(79)}😀`);
      expect(await (await call(`/${ns}/${emojiText.id}`)).text()).toBe(withEmoji);
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
      // A short text, kept in the database rather than as a file: sandboxed all the same.
      const markup = await parse<Item>(sendText(ns, "<script>alert(1)</script>"));
      const shown = await call(`/${ns}/${markup.id}`);
      expect(shown.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(shown.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    });

    test("shows an SVG as an image, and never runs it", async () => {
      const ns = fresh();
      const drawing = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      const image = await json<FileItem>(`/${ns}/new`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": encodeURIComponent("drawing.html"),
        },
        body: drawing,
      });
      expect(image).toMatchObject({
        kind: "image",
        mime: "image/svg+xml",
        filename: "drawing.svg",
      });
      for (const path of [`/${ns}/${image.id}`, `/${ns}/${image.id}/d`]) {
        const shown = await call(path);
        expect(shown.headers.get("content-type")).toBe("image/svg+xml");
        expect(shown.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
        expect(shown.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await shown.text()).toBe(drawing);
      }
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
};
