// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
//
// Tests that hold on every platform: they only speak HTTP to the server, and
// reach its storage through the harness. The Worker and the Bun server each
// run them with their own harness, next to their platform-specific tests.

import type { expect as vitestExpect } from "vitest";
import { newViewId, openSealedSpace, openSharedItem, openViewEntry } from "../public/k.mjs";
import { BUNDLE_MIME, readBundle, writeBundle } from "../src/client/shared/bundle.js";
import { describePlain, rowHash, rowState } from "../src/client/shared/item-row.js";
import type { AppConfig } from "../src/config";
import type { AccessLogEntry } from "../src/core/visits";
import { defined, type FileItem, type Item, type SharedItem } from "./support";

export type Harness = {
  describe: (name: string, body: () => void) => void;
  test: (name: string, body: () => Promise<void>, timeoutMs?: number) => void;
  expect: typeof vitestExpect;
  /** Calls the server: a different client address each time unless cf-connecting-ip is set. */
  call: (path: string, init?: RequestInit) => Promise<Response>;
  /** The keys of the stored files under a prefix. */
  storedFiles: (prefix: string) => Promise<string[]>;
  config: AppConfig;
  /**
   * Waits, if need be, until a whole per-minute limit can be spent in one
   * window of the platform's limiter: called before a test that spends one.
   */
  limitWindow: () => Promise<void>;
  /** The site's address, as absolute links show it. */
  origin: string;
  adminKey: string;
};

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** For tests that spend a whole per-minute limit, one request at a time. */
const LIMIT_TEST_MS = 60_000;
const parse = async <T = unknown>(response: Response | Promise<Response>) =>
  (await response).json() as Promise<T>;
type PublicConfig = { namespace: { pattern: string; reserved: string[] } };

export const sharedTests = (harness: Harness) => {
  // The origin is read when a test runs: a server may only start before the tests.
  const { describe, test, expect, call, storedFiles, config, adminKey, limitWindow } = harness;
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
  const freshSealedSpace = () => openSealedSpace(`test ${crypto.randomUUID()}`);

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
      // The browser keeps the server's row only if it would make the same one:
      // the hash of what it makes it from, out of /ls?summary, must match.
      const [item] = await json<Item[]>(`/${ns}/ls?summary`);
      const made = rowHash(rowState(item, describePlain(item), false, true));
      expect(page).toContain(`data-id="${defined(item, "the item").id}" data-made="${made}"`);
      // And the queue itself, as /ls?summary gives it, with the revision live
      // updates continue from, so the page fetches nothing to start.
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
    test(
      "allows the configured sends a minute per address, then answers 429",
      async () => {
        await limitWindow();
        const ns = fresh("limit");
        const ip = { "cf-connecting-ip": "192.0.2.199" };
        const statuses: number[] = [];
        for (let index = 0; index < config.sendsPerMinute; index += 1) {
          statuses.push((await sendText(ns, `item ${index}`, ip)).status);
        }
        expect(statuses.every((status) => status === 201)).toBe(true);
        const blocked = await sendText(ns, "one too many", ip);
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("retry-after")).toBe("60");
        // Another address is not affected.
        expect(
          (await sendText(ns, "someone else", { "cf-connecting-ip": "192.0.2.200" })).status,
        ).toBe(201);
      },
      LIMIT_TEST_MS,
    );
  });

  describe("automated networks", () => {
    test(
      "a cloud's addresses share their block's budget; a home in it keeps its own",
      async () => {
        await limitWindow();
        const ns = fresh("cloud");
        // Addresses of one /24 on Amazon's network (ASN 16509), as a script spread over them.
        const cloud = (last: number) => ({
          "cf-connecting-ip": `100.64.5.${last}`,
          "cf-asn": "16509",
        });
        const statuses: number[] = [];
        // Spread over the block's addresses, apart from the home one below.
        for (let index = 0; index < config.sendsPerMinute; index += 1) {
          statuses.push((await sendText(ns, `cloud ${index}`, cloud((index % 200) + 1))).status);
        }
        expect(statuses.every((status) => status === 201)).toBe(true);
        expect((await sendText(ns, "one more", cloud(200))).status).toBe(429);
        // Another provider block, and a home address in the same /24, are counted apart.
        expect(
          (
            await sendText(ns, "next block", {
              "cf-connecting-ip": "100.64.6.1",
              "cf-asn": "16509",
            })
          ).status,
        ).toBe(201);
        expect((await sendText(ns, "a home", { "cf-connecting-ip": "100.64.5.250" })).status).toBe(
          201,
        );
      },
      LIMIT_TEST_MS,
    );
  });

  describe("miss limit", () => {
    test(
      "past the configured requests for things that are not there, the client reads nothing",
      async () => {
        await limitWindow();
        const ns = fresh("present");
        await sendText(ns, "here all along");
        const scanner = { "cf-connecting-ip": "192.0.2.210" };
        // Names, items and share links that do not exist: each one a miss.
        for (let index = 0; index <= config.missesPerMinute; index += 1) {
          const path =
            index % 3 === 0
              ? `/${fresh("absent")}/ls`
              : index % 3 === 1
                ? `/${ns}/zzzzzz`
                : "/i/AAAAAAAAAAAAAA";
          expect((await call(path, { headers: scanner })).status).not.toBe(429);
        }
        // Now even what exists answers 429: otherwise the answers would tell
        // a script which names exist.
        const blocked = await call(`/${ns}/1`, { headers: scanner });
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("retry-after")).toBe("60");
        // Another client reads as usual, and pages outside namespaces stay open.
        const other = await call(`/${ns}/1`, { headers: { "cf-connecting-ip": "192.0.2.211" } });
        expect(await other.text()).toBe("here all along");
        expect((await call("/.well-known/kurobako", { headers: scanner })).status).toBe(200);
      },
      LIMIT_TEST_MS,
    );
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
      expect(alphaLog).toContain(`href="/${alpha}">Back to namespace</a>`);
      expect(alphaLog).toContain(`href="/${alpha}/log.json">As JSON</a>`);
      expect(alphaLog).toMatch(/type="module" src="\/k\/assets\/log-[0-9a-z]+\.js"/);
      expect(alphaLog).not.toContain("<main data-loading>");
      expect(alphaLog).not.toContain('id="log-back-row" hidden');
      expect((await call("/log.json")).status).toBe(404);
    });

    test("does not create namespaces for probes", async () => {
      const ns = fresh();
      await call(`/${ns}/ls`, { headers: { "cf-connecting-ip": "192.0.2.9" } });
      expect(await json<AccessLogEntry[]>(`/${ns}/log.json`)).toEqual([]);
    });
  });

  describe("encrypted namespaces", () => {
    test("only the name-derived write key can mutate, including the first send", async () => {
      const space = await freshSealedSpace();
      const path = `/e/${space.id}`;
      const body = new Uint8Array([1, 2, 3]);
      const send = (writeKey?: string) =>
        call(`${path}/new`, {
          method: "POST",
          headers: {
            "x-sealed-metadata": "a2V5.bWV0YQ",
            ...(writeKey ? { "write-key": writeKey } : {}),
          },
          body,
        });
      expect((await send()).status).toBe(401);
      expect((await send("wrong")).status).toBe(403);
      expect(await json<Item[]>(`${path}/ls`)).toEqual([]);
      const item = await parse<Item>(send(space.writeKey));
      const unprivileged = [
        call(`${path}/${item.id}/s`),
        call(`${path}/${item.id}/n`, {
          method: "POST",
          headers: {
            "if-match": JSON.stringify(item.createdAt),
            "x-sealed-metadata": "a2V5.bWV0YQ",
          },
        }),
        call(`${path}/${item.id}/e`, {
          method: "POST",
          headers: {
            "if-match": JSON.stringify(item.createdAt),
            "x-sealed-metadata": "a2V5.bWV0YQ",
          },
          body,
        }),
        call(`${path}/${item.id}`, { method: "DELETE" }),
      ];
      expect((await Promise.all(unprivileged)).map((response) => response.status)).toEqual([
        401, 401, 401, 401,
      ]);
      const details = await json<Item & { shareUrl?: string }>(`${path}/${item.id}.json`);
      expect(details.shareUrl).toBeUndefined();
      expect((await call(`${path}/${item.id}`)).status).toBe(200);
      expect(
        (
          await call(`${path}/${item.id}`, {
            method: "DELETE",
            headers: { "write-key": space.writeKey },
          })
        ).status,
      ).toBe(200);
    });

    test("store ciphertext apart from plain namespaces", async () => {
      const space = await freshSealedSpace();
      const id = space.id;
      const ciphertext = new Uint8Array([1, 2, 3, 4, 5]);
      expect((await call(`/e/${id}/new`, { method: "POST", body: ciphertext })).status).toBe(401);
      expect(
        (
          await call(`/e/${id}/new`, {
            method: "POST",
            headers: { "write-key": "wrong" },
            body: ciphertext,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(`/e/${id}/new`, {
            method: "POST",
            headers: { "write-key": space.writeKey },
            body: ciphertext,
          })
        ).status,
      ).toBe(400);

      const item = await json<Item>(`/e/${id}/new`, {
        method: "POST",
        headers: { "x-sealed-metadata": "a2V5.bWV0YQ", "write-key": space.writeKey },
        body: ciphertext,
      });
      expect(item).toMatchObject({ kind: "sealed", metadata: "a2V5.bWV0YQ", size: 5 });
      expect(item).not.toHaveProperty("contentUrl");
      const content = await call(`/e/${id}/${item.id}`);
      expect(content.headers.get("content-type")).toBe("application/octet-stream");
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(ciphertext);
      // /c is the same, as on a share link.
      const viaC = await call(`/e/${id}/${item.id}/c`);
      expect(new Uint8Array(await viaC.arrayBuffer())).toEqual(ciphertext);
      // Its name is sealed: a download goes by its ID, so curl -OJ names it sensibly.
      const download = await call(`/e/${id}/${item.id}/d`);
      expect(download.headers.get("content-disposition")).toContain(`filename="${item.id}.sealed"`);
      // A plain namespace with a similar name holds nothing of it.
      const twin = id.toLowerCase().replace(/[^a-z0-9]/g, "0");
      expect(await json<Item[]>(`/${twin}/ls`)).toEqual([]);

      expect(
        (
          await call(`/e/${id}/${item.id}`, {
            method: "DELETE",
            headers: { "write-key": space.writeKey },
          })
        ).status,
      ).toBe(200);
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
        headers: { "x-sealed-metadata": header, "write-key": space.writeKey },
        body,
      });

      // With the name: list, unwrap the item key, read.
      const listed = defined((await json<Item[]>(`/e/${space.id}/ls`))[0], "the item in the list");
      const opened = await space.openItem(listed.metadata, listed.size);
      expect(opened.metadata).toEqual({
        kind: "text",
        title: "greeting",
        size: contents.byteLength,
        rev: 0,
      });
      const sealed = await (await call(`/e/${space.id}/${listed.id}`)).arrayBuffer();
      expect(new TextDecoder().decode(await opened.open(sealed))).toBe(
        "olá, só para quem tem o nome",
      );
      expect(opened.keyText).toBe(keyText);

      // With only a share link's key: the same item, and nothing else.
      const url = await shareLink(`/e/${space.id}/${item.id}/s`, {
        headers: { "write-key": space.writeKey },
      });
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

    test("serve the page, refuse bad IDs and keep the encrypted log's back link client-side", async () => {
      const page = await (await call("/e")).text();
      expect(page).toContain("<html");
      expect(page).toContain("Decrypting namespace…");
      expect(page).toContain('id="page-loading"');
      expect((await call("/e/kk/ls")).status).toBe(404);
      const space = await freshSealedSpace();
      const id = space.id;
      await call(`/e/${id}/new`, {
        method: "POST",
        headers: {
          "x-sealed-metadata": "a2V5.eA",
          "cf-connecting-ip": "203.0.113.7",
          "write-key": space.writeKey,
        },
        body: "x",
      });
      const log = await (await call(`/e/${id}/log`)).text();
      expect(log).toContain("203.0.113.7");
      expect(log).toContain("encrypted namespace");
      expect(log).toContain('id="log-back-row" hidden');
      // Its name comes from the fragment: the log shows once log.js put it in.
      expect(log).toContain("Decrypting access log…");
      expect(log).toMatch(/src="\/k\/assets\/log-[0-9a-z]+\.js"/);
      expect(log).not.toContain(`href="/e/${id}"`);
    });
  });

  describe("shared namespace views", () => {
    const viewId = () =>
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");

    test("plain views follow sends, then freeze membership on rotation", async () => {
      const ns = fresh("view");
      const first = await parse<Item>(sendText(ns, "one"));
      const created = await json<{ token: string; url: string }>(`/${ns}/views`, {
        method: "POST",
        body: JSON.stringify({
          viewId: viewId(),
          previousToken: null,
          entries: [{ id: first.id }],
        }),
      });
      expect(created.url).toBe(`/v/${created.token}`);
      const second = await parse<Item>(sendText(ns, "two"));
      const contents = await json<{ entries: { url: string; item: Item }[] }>(
        `${created.url}.json`,
      );
      expect(contents.entries.map(({ item }) => item.text)).toEqual(["two", "one"]);
      expect(JSON.stringify(contents)).not.toContain(ns);
      const page = await (await call(created.url)).text();
      expect(page).toContain('id="view-data"');
      expect(page).toContain('id="clone-field" class="namespace-input"');
      expect(page).toContain('id="clone-encrypted"');
      expect(page).not.toContain('id="clone-mode"');
      expect(page).not.toContain("%CONFIG%");
      expect(page).toContain('id="media-feed-list"');
      expect(page).toContain('id="items" class="items"');
      expect(page).toContain('class="item-title">two');
      // Rows as view.js would make them (named by their link's token), so it keeps them.
      for (const { url, item } of contents.entries) {
        const shown = { ...item, id: url.split("/").pop() };
        const made = rowHash(
          rowState(shown, { ...describePlain(item), itemUrl: url }, false, false),
        );
        expect(page).toContain(`data-id="${shown.id}" data-made="${made}"`);
      }
      expect(page).not.toContain('id="page-loading"');
      expect(page).not.toContain("%MEDIA_FEED%");
      expect(page).not.toContain(ns);
      expect(contents.entries.every(({ url }) => url.startsWith("/i/"))).toBe(true);
      const next = await json<{ url: string }>(`/${ns}/views`, {
        method: "POST",
        body: JSON.stringify({
          viewId: viewId(),
          previousToken: created.token,
          entries: [{ id: second.id }, { id: first.id }],
        }),
      });
      await sendText(ns, "three");
      expect((await json<{ entries: unknown[] }>(`${created.url}.json`)).entries).toHaveLength(2);
      expect((await json<{ entries: unknown[] }>(`${next.url}.json`)).entries).toHaveLength(3);
      const edited = await call(`/${ns}/${first.id}/e`, {
        method: "POST",
        headers: { "content-type": "text/plain", "if-match": JSON.stringify(first.createdAt) },
        body: "one edited",
      });
      expect(edited.status).toBe(200);
      expect(JSON.stringify(await json(`${created.url}.json`))).toContain("one edited");
      expect((await call(`/${ns}/${first.id}`, { method: "DELETE" })).status).toBe(200);
      expect((await json<{ entries: unknown[] }>(`${created.url}.json`)).entries).toHaveLength(1);
    });

    test("a view never reveals limited text before a consuming read", async () => {
      const ns = fresh("viewlimited");
      const item = await parse<Item>(sendText(ns, "private phrase", { Reads: "2" }));
      const created = await json<{ url: string }>(`/${ns}/views`, {
        method: "POST",
        body: JSON.stringify({
          viewId: viewId(),
          previousToken: null,
          entries: [{ id: item.id }],
        }),
      });
      const index = await json<{ entries: { item: Item; url: string }[] }>(`${created.url}.json`);
      expect(index.entries).toHaveLength(1);
      expect(JSON.stringify(index)).not.toContain("private phrase");
      const entry = index.entries[0];
      if (!entry) throw new Error("Expected a shared item.");
      expect(entry.item).not.toHaveProperty("text");
      expect(entry.item).not.toHaveProperty("name");
      expect(await (await call(`${entry.url}/c`)).text()).toBe("private phrase");
      expect(
        (await json<{ entries: { item: Item }[] }>(`${created.url}.json`)).entries[0]?.item,
      ).toHaveProperty("readsLeft", 1);
    });

    test("encrypted sends require an envelope for the current view", async () => {
      const space = await freshSealedSpace();
      const path = `/e/${space.id}`;
      const firstSealed = await space.sealItem(new TextEncoder().encode("one"), {
        kind: "text",
        title: "one",
        size: 3,
      });
      const headers = { "write-key": space.writeKey, "x-sealed-metadata": firstSealed.header };
      const first = await parse<Item>(
        call(`${path}/new`, {
          method: "POST",
          headers,
          body: firstSealed.body,
        }),
      );
      const id = newViewId();
      const envelope = await space.sealViewEntry(id, firstSealed.keyText);
      const created = await json<{ token: string; url: string }>(`${path}/views`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          viewId: id,
          previousToken: null,
          entries: [{ id: first.id, envelope }],
        }),
      });
      const secondSealed = await space.sealItem(new TextEncoder().encode("two"), {
        kind: "text",
        title: "two",
        size: 3,
      });
      const nextHeaders = { ...headers, "x-sealed-metadata": secondSealed.header };
      expect(
        (
          await call(`${path}/new`, {
            method: "POST",
            headers: nextHeaders,
            body: secondSealed.body,
          })
        ).status,
      ).toBe(409);
      const sent = await call(`${path}/new`, {
        method: "POST",
        headers: {
          ...nextHeaders,
          "view-token": created.token,
          "view-envelope": await space.sealViewEntry(id, secondSealed.keyText),
        },
        body: secondSealed.body,
      });
      expect(sent.status).toBe(201);
      const view = await json<{ entries: { envelope: string }[] }>(`${created.url}.json`);
      expect(view.entries).toHaveLength(2);
      const page = await (await call(created.url)).text();
      expect(page).not.toContain(space.id);
      expect(page).toContain("Decrypting shared view…");
      // Shown alone until decrypted, as an encrypted namespace is.
      expect(page).toContain('<main data-loading="">');
      expect(page).toContain('id="page-loading"');
      expect(await openViewEntry(id, await space.viewKey(id), view.entries[0]?.envelope)).toBe(
        secondSealed.keyText,
      );
      expect((await call(`${path}/views`)).status).toBe(401);
    });

    test("two rotations from one active view cannot both win", async () => {
      const ns = fresh("viewrace");
      const item = await parse<Item>(sendText(ns, "first"));
      const first = await json<{ token: string }>(`/${ns}/views`, {
        method: "POST",
        body: JSON.stringify({ viewId: viewId(), previousToken: null, entries: [{ id: item.id }] }),
      });
      const rotate = () =>
        call(`/${ns}/views`, {
          method: "POST",
          body: JSON.stringify({
            viewId: viewId(),
            previousToken: first.token,
            entries: [{ id: item.id }],
          }),
        });
      const results = await Promise.all([rotate(), rotate()]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    });

    test("rejects noncanonical view IDs", async () => {
      const ns = fresh("viewid");
      const response = await call(`/${ns}/views`, {
        method: "POST",
        body: JSON.stringify({ viewId: `${"A".repeat(21)}B`, previousToken: null, entries: [] }),
      });
      expect(response.status).toBe(400);
    });
  });

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
      expect(page).toContain("&lt;/script&gt;&lt;b&gt;");
      expect(page).toContain('data-ssr-rendered="true"');
    });

    test("renders a shared long text from blob storage in the first response", async () => {
      const ns = fresh("share");
      const long = "long text ".repeat(7_000);
      const item = await parse<Item>(sendText(ns, long));
      const page = await (await call(await share(`/${ns}`, item.id))).text();
      expect(page).toContain(`<pre>${long}</pre>`);
      expect(page).toContain('data-ssr-rendered="true"');
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

  describe("live updates", () => {
    test("require a WebSocket upgrade", async () => {
      expect((await call(`/${fresh()}/live`)).status).toBe(426);
    });
  });

  describe("site", () => {
    test("assembles pages: bundled scripts, footer and the embedded config", async () => {
      const html = await (await call(`/${fresh()}`)).text();
      // The page's script, named by its contents: one file, with everything
      // it imports at once, so nothing to preload and no import left in it.
      const script = html.match(
        /<script type="module" src="(\/k\/assets\/namespace-[0-9a-z]+\.js)"/,
      )?.[1];
      const response = await call(defined(script, "the namespace page's script"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
      expect(html).not.toContain('rel="modulepreload"');
      const code = await response.text();
      expect(code).not.toMatch(/\bfrom\s*"\.\//);
      // What it loads later (highlight.js, the QR code) is there to load.
      const later = [...code.matchAll(/import\("\.\/([^"]+\.js)"\)/g)];
      expect(later.length).toBeGreaterThan(0);
      for (const [, file] of later) {
        expect((await call(`/k/assets/${defined(file, "a later file")}`)).status).toBe(200);
      }
      expect(html).toMatch(/\(build [0-9a-f]{12}\)/);
      expect(html.match(/<input id="[a-z-]+" class="file-drop"/g)).toHaveLength(2);
      // The limits come written: the page's script does not fill them in.
      expect(html).toContain('<option value="">Instance default (1 day)</option>');
      // Expiry is each item's: the namespace does not claim one.
      expect(html).not.toContain("expiry-label");
      expect(html).toMatch(/id="file-limit" class="hint">Any files, up to \d+ at once/);
      expect(html).toContain('<input id="burn" type="checkbox"/>');
      expect(html).toContain('id="media-feed-list"');
      expect(html).not.toContain("%MEDIA_FEED%");
      expect(html).not.toContain('id="reads-limit"');
      const home = await (await call("/")).text();
      expect(home).toContain(
        '<span id="namespace-prefix" class="namespace-prefix" aria-hidden="true">/e#</span>',
      );
      expect(home).toContain('aria-label="Enable end-to-end encryption"');
      expect(home).toContain('id="e2ee-help"');
      expect(home).toContain('id="e2ee-dialog" class="dialog"');
      expect(home).toMatch(
        /href="\/k\/assets\/styles-[0-9a-f]+\.css"[\s\S]*src="\/k\/assets\/site-[0-9a-z]+\.js"/,
      );
      expect(home).toMatch(/id="random-name"[^>]*>Random name<\/button>/);
      expect(home).toContain('href="/stats.json">Full statistics</a>');
      expect(home).toMatch(/class="external-link"[^>]*>Source<\/a>/);
      expect(home).toContain('id="namespace-hint" class="hint">E2EE. Max 256 characters.</p>');
      expect(home).toContain('maxlength="256"');
      expect(home).toContain(
        'id="theme-toggle" class="theme-toggle" type="button" data-theme-choice="auto" hidden',
      );
      expect(home).toContain('id="stats-section" class="stack page-section"');
      expect(home).not.toContain('id="toggle-stats"');
      expect(home).not.toContain("data-stat=");
      expect(home).not.toContain('id="misses-per-minute"');
      expect(home).not.toContain('id="max-storage"');
      expect(home).toContain(`<td id="max-items">${config.maxItems.toLocaleString("en-US")}</td>`);
      expect(home).toContain(
        `<td id="sends-per-minute">${config.sendsPerMinute.toLocaleString("en-US")}</td>`,
      );
      expect(home).not.toContain("%MAX_FILE_SIZE%");

      const embedded = html.match(
        /<script type="application\/json" id="config">(.*?)<\/script>/s,
      )?.[1];
      expect(JSON.parse(defined(embedded, "the embedded config"))).toEqual(
        await json("/.well-known/kurobako"),
      );
    });

    test("controls are words: the only icons are the theme button's", async () => {
      const ns = fresh();
      await sendText(ns, "no icons");
      for (const path of ["/", `/${ns}`, `/${ns}/log`, "/k/protocol", "/k/licenses", "/k/share"]) {
        const html = await (await call(path)).text();
        expect(html, path).not.toContain("data-icon");
        // The theme button's three (auto, light, dark), and nothing else.
        expect(html.match(/<svg/g), path).toHaveLength(3);
      }
    });

    test("installs as an app whose shares never reach the server", async () => {
      const response = await call("/manifest.webmanifest");
      expect(response.headers.get("content-type")).toContain("application/manifest+json");
      const manifest = (await response.json()) as {
        icons: { src: string; sizes: string; purpose: string }[];
      };
      expect(manifest).toMatchObject({
        start_url: "/",
        scope: "/",
        display: "standalone",
        share_target: { action: "/k/share", method: "POST", enctype: "multipart/form-data" },
      });
      // Every icon is there, at the size it says, and Android gets one to shape.
      expect(manifest.icons.map((icon) => icon.purpose)).toContain("maskable");
      for (const icon of manifest.icons) {
        const image = await call(icon.src);
        expect(image.headers.get("content-type"), icon.src).toBe("image/png");
        const header = new DataView(await image.arrayBuffer());
        expect(`${header.getUint32(16)}x${header.getUint32(20)}`, icon.src).toBe(icon.sizes);
      }
      // Every page links it, and installs the Service Worker that takes shares.
      const home = await (await call("/")).text();
      expect(home).toContain('<link rel="manifest" href="/manifest.webmanifest"/>');
      // In head/site.js, every page's one classic script, before the first paint.
      expect(home).toMatch(/<script src="\/k\/assets\/site-[0-9a-z]+\.js"><\/script>/);
      expect(home.match(/<script src=/g)).toHaveLength(1);
      // Without the Service Worker, a share is turned back unread.
      const form = new FormData();
      form.set("text", "never stored");
      const lost = await call("/k/share", { method: "POST", body: form, redirect: "manual" });
      expect(lost.status).toBe(303);
      expect(lost.headers.get("location")).toBe("/k/share?lost");
      const page = await (await call("/k/share")).text();
      expect(page).toContain('id="share-form"');
      expect(page).toContain('<meta name="robots" content="noindex"/>');
    });

    test("offers no notifications without VAPID keys", async () => {
      const ns = fresh("nopush");
      await sendText(ns, "here");
      expect((await json<{ push: unknown }>("/.well-known/kurobako")).push).toBeNull();
      const subscribe = await call(`/${ns}/push`, { method: "POST", body: "{}" });
      expect(subscribe.status).toBe(404);
    });

    test("publishes the project and production dependency licenses separately", async () => {
      const html = await (await call("/k/licenses")).text();
      expect(html).toContain("AGPL-3.0-or-later");
      expect(html).toContain("Hono");
      expect(html).toContain("Highlight.js 11.12.0");
      expect(html).toContain("uQR 0.1.3");
      expect(html).toContain("Garage 2");
      expect(html).toContain("Optional service");
      expect(html).toContain("Full MIT license and notice");
      expect(html).not.toContain("%APP_VERSION%");
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
      expect(body.namespace.reserved).toEqual(["e", "i", "k", "v"]);
    });
  });

  describe("admin dashboard", () => {
    const login = (key: string, ip: string) =>
      call("/k/a/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ key }),
      });

    test("requires the key and locks out repeated failures", async () => {
      const loggedOut = await (await call("/k/a")).text();
      expect(loggedOut).toContain("<html");
      expect(loggedOut).not.toContain('id="admin-data"');
      expect(loggedOut).toContain('<div id="dashboard" hidden="">');
      expect((await call("/k/a/overview")).status).toBe(401);

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
      expect((await call("/k/a/overview", { headers: { cookie: session } })).status).toBe(200);
      // Logged in, the page comes open, with what the dashboard would ask for first.
      const page = await call("/k/a", { headers: { cookie: session } });
      expect(page.headers.get("cache-control")).toBe("no-store");
      const html = await page.text();
      expect(html).toMatch(/<form id="login-form"[^>]* hidden="">/);
      const embedded = /<script type="application\/json" id="admin-data">(.*?)<\/script>/s.exec(
        html,
      )?.[1];
      expect(JSON.parse(defined(embedded, "the embedded dashboard"))).toMatchObject({
        overview: { version: expect.any(String) },
        namespaces: { items: expect.any(Array), total: expect.any(Number) },
      });
      const forged = session.replace(/\.[^.]+$/, ".forged-signature");
      expect((await call("/k/a/overview", { headers: { cookie: forged } })).status).toBe(401);
    });

    test("logs in and out from the page's own forms, with no script", async () => {
      const form = (path: string, body: Record<string, string>, ip: string) =>
        call(path, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "cf-connecting-ip": ip,
          },
          body: new URLSearchParams(body).toString(),
        });
      // Logged out, the page is its form and loads no script.
      const page = await (await call("/k/a")).text();
      expect(page).toMatch(/<form id="login-form"[^>]*method="post" action="\/k\/a\/login"/);
      expect(page).not.toContain('type="module"');

      const wrong = await form("/k/a/login", { key: "wrong-key" }, "203.0.113.160");
      expect(wrong.status).toBe(401);
      expect(await wrong.text()).toContain(
        'class="status error" role="status" aria-live="polite">Wrong key.',
      );

      const right = await form("/k/a/login", { key: adminKey }, "203.0.113.161");
      expect(right.status).toBe(303);
      expect(right.headers.get("location")).toBe("/k/a");
      const session = defined(right.headers.get("set-cookie"), "a session").split(";", 1)[0] ?? "";
      expect(await (await call("/k/a", { headers: { cookie: session } })).text()).toContain(
        'id="admin-data"',
      );

      const out = await call("/k/a/logout", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: session },
      });
      expect(out.status).toBe(303);
      expect(out.headers.get("location")).toBe("/k/a");
      expect(out.headers.get("set-cookie")).toContain("kurobako_admin=;");
    });
  });
};
