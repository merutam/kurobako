// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { newViewId, openSealedSpace, openSharedItem, openViewEntry } from "../../public/k.mjs";
import { describePlain, rowHash, rowState } from "../../src/web/client/shared/item-row.js";
import { defined, type Item, type SharedItem } from "../support";
import type { Harness } from "./index";
import { parse, type Tools } from "./tools";

export const encryptedTests = (harness: Harness, tools: Tools) => {
  const { describe, test, expect, call } = harness;
  const { json, sendText, shareLink, fresh, freshSealedSpace } = tools;
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

    test("a view's items are found as a namespace's: by position or token", async () => {
      const ns = fresh("view");
      const first = await parse<Item>(sendText(ns, "one"));
      const created = await json<{ url: string }>(`/${ns}/views`, {
        method: "POST",
        body: JSON.stringify({
          viewId: viewId(),
          previousToken: null,
          entries: [{ id: first.id }],
        }),
      });
      await sendText(ns, "two");
      const listed = await json<Item[]>(`${created.url}/ls`);
      const [newest, oldest] = listed.map(({ id }) => id);

      expect(await (await call(`${created.url}/1`)).text()).toBe("two");
      expect(await (await call(`${created.url}/2/c`)).text()).toBe("one");
      expect(await (await call(`${created.url}/${newest}`)).text()).toBe("two");
      const download = await call(`${created.url}/2/d`);
      expect(download.headers.get("content-disposition")).toMatch(/^attachment/);
      expect(await download.text()).toBe("one");

      const details = await json<Item & { position: number; shareUrl: string }>(
        `${created.url}/2.json`,
      );
      expect(details).toMatchObject({ id: oldest, position: 2, text: "one" });
      expect(new URL(details.shareUrl).pathname).toBe(`/i/${oldest}`);
      expect(await shareLink(`${created.url}/2/s`)).toBe(`/i/${oldest}`);
      // Nothing that leads back to the namespace.
      expect(JSON.stringify(details)).not.toContain(ns);
      expect(JSON.stringify(details)).not.toContain(first.id);

      expect((await call(`${created.url}/3`)).status).toBe(404);
      // Another namespace's share link is not one of this view's items.
      const other = fresh("view");
      await sendText(other, "elsewhere");
      const foreign = (await shareLink(`/${other}/1/s`)).split("/").pop();
      expect((await call(`${created.url}/${foreign}`)).status).toBe(404);
    });

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
      const listing = await json<Item[]>(`${created.url}/ls`);
      expect(listing.map(({ text }) => text)).toEqual(["two", "one"]);
      expect(listing.map(({ id }) => id)).toEqual(
        contents.entries.map(({ url }) => url.split("/").pop()),
      );
      expect(JSON.stringify(listing)).not.toContain(ns);
      expect(JSON.stringify(listing)).not.toContain(first.id);
      expect(JSON.stringify(listing)).not.toContain(second.id);
      expect((await json<Item[]>(`${created.url}/ls?limit=1`)).map(({ text }) => text)).toEqual([
        "two",
      ]);
      expect((await call(`${created.url}/ls?limit=0`)).status).toBe(400);
      expect(page).toContain(`href="${created.url}/ls">As JSON</a>`);
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

    test("shared listings preview long text with ?summary", async () => {
      const ns = fresh("viewsummary");
      const text = "long shared text ".repeat(30);
      const item = await parse<Item>(sendText(ns, text));
      const created = await json<{ url: string }>(`/${ns}/views`, {
        method: "POST",
        body: JSON.stringify({
          viewId: viewId(),
          previousToken: null,
          entries: [{ id: item.id }],
        }),
      });
      const { id } = defined((await json<Item[]>(`${created.url}/ls`))[0], "shared item");
      const [summary] = await json<Item[]>(`${created.url}/ls?summary`);
      expect(summary).toMatchObject({ id, preview: text.slice(0, 280) });
      expect(summary?.text).toBeUndefined();
      const [single] = await json<Item[]>(`/i/${id}/ls?summary`);
      expect(single).toEqual(summary);
      expect((await json<Item[]>(`/i/${id}/ls`))[0]?.text).toBe(text);
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
      expect(await json<unknown[]>(`${created.url}/ls`)).toMatchObject([
        { kind: "sealed", envelope: view.entries[0]?.envelope, viewId: id },
        { kind: "sealed", envelope: view.entries[1]?.envelope, viewId: id },
      ]);
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
};
