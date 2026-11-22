// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Rules kept in two places: the server's and the clients'.
import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, hkdfSync, pbkdf2Sync } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  bodyKey,
  BUNDLE_MIME as CLI_BUNDLE_MIME,
  TEXT_PREVIEW_CHARS as CLI_TEXT_PREVIEW_CHARS,
  detectMedia as cliDetectMedia,
  defaultTextName as clientDefaultName,
  formatBytes as cliFormatBytes,
  contentSize,
  fileMetadata,
  PROTOCOL as K_PROTOCOL,
  VERSION as K_VERSION,
  openReadOnlySpace,
  openSealedSpace,
  openSegments,
  openSharedItem,
  safeName,
  suggestedTextFileBase,
  textDownloadName,
  textFileBase,
} from "../../public/k.mjs";
import { SECURITY_HEADERS } from "../../src/app";
import { FIXED_FILES, ICON_FILES, STYLES, TOKENS } from "../../src/assets";
import { loadConfig } from "../../src/config";
import { detectMedia, safeFileName, safeMediaName } from "../../src/domain/media";
import { defaultTextName, TEXT_PREVIEW_CHARS } from "../../src/domain/model";
import { PROTOCOL_VERSION } from "../../src/domain/routing";
import {
  BUNDLE_MIME,
  isBundle,
  readBundle,
  uniqueNames,
  writeBundle,
} from "../../src/protocol/bundle.js";
import { bundle } from "../../src/web/client/build";
import { formatBytes as pageFormatBytes } from "../../src/web/client/lib/common.js";
import { coverFromTag } from "../../src/web/client/lib/cover.js";
import { sealedFileLimit } from "../../src/web/client/shared/limits.js";
import { defined } from "../support";
import { useDefaultServer } from "./harness";

useDefaultServer();

describe("rules kept in two places", () => {
  test("default text names", () => {
    const texts = [
      "short",
      "  spaced\n\tout  text ",
      `Shopping list for the weekend: ${"rice, beans, coffee, ".repeat(5)}`,
      "x".repeat(200),
      `${"word ".repeat(15)}end, and more punctuation!?`,
      "Ação, café e pão: uma lista com acentos que passa bem dos oitenta caracteres sim",
      `${"a".repeat(79)}😀and more`,
      "😀".repeat(81),
      "one\uFEFFtwo",
      "one\u0085two",
      // Cut right after a dash: en, em and the plain hyphen all go.
      ...["\u2013", "\u2014", "-"].map((dash) => `${"a".repeat(70)} b ${dash} ${"c".repeat(20)}`),
    ];
    for (const text of texts) expect(clientDefaultName(text)).toBe(defaultTextName(text));
    for (const dash of ["\u2013", "\u2014", "-"]) {
      expect(defaultTextName(`${"a".repeat(70)} b ${dash} ${"c".repeat(20)}`)).toBe(
        `${"a".repeat(70)} b`,
      );
    }
    expect(defaultTextName(`${"a".repeat(79)}😀and more`)).toBe(`${"a".repeat(79)}😀`);
    expect(defaultTextName("😀".repeat(81))).toBe("😀".repeat(80));
    expect(defaultTextName("What is this?")).toBe("What is this?");
    expect(defaultTextName("one\uFEFFtwo")).toBe("one two");
    expect(defaultTextName("one\u0085two")).toBe("one\u0085two");
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
    expect(suggestedTextFileBase('import x from "./lib/x.js";')).toBe("import x from lib x js");
    expect(suggestedTextFileBase(" ")).toBe("text");
    expect(textFileBase("Notes / code")).toBe("Notes - code");
    expect(textDownloadName("answer.js", "abc")).toBe("answer.js");
    expect(textDownloadName("old title", "abc")).toBe("old title.txt");
    expect(textDownloadName("", "abc")).toBe("text-abc.txt");
  });

  test("finds an audio file's cover in its ID3v2 tag, the front one first", async () => {
    const latin1 = (text: string) => [...text].map((c) => c.charCodeAt(0));
    const syncsafe = (n: number) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
    const plain32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    const png = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];
    const jpeg = [0xff, 0xd8, 0xff, 9, 9];
    /** An APIC frame: Latin-1 description, then the picture. */
    const apic = (version: 3 | 4, type: number, picture: number[]) => {
      const body = [0, ...latin1("image/png"), 0, type, ...latin1("desc"), 0, ...picture];
      return [
        ...latin1("APIC"),
        ...(version === 4 ? syncsafe : plain32)(body.length),
        0,
        0,
        ...body,
      ];
    };
    const tag = (version: 3 | 4, frames: number[][]) => {
      const body = frames.flat();
      return new Uint8Array([
        ...latin1("ID3"),
        version,
        0,
        0,
        ...syncsafe(body.length),
        ...body,
        1,
        2,
      ]);
    };
    const bytesOf = async (blob: Blob | null) => [
      ...new Uint8Array(await defined(blob, "a cover").arrayBuffer()),
    ];

    const v3 = coverFromTag(tag(3, [apic(3, 0, jpeg), apic(3, 3, png)]));
    expect(await bytesOf(v3)).toEqual(png);
    expect(v3?.type).toBe("image/png");
    const v4 = coverFromTag(tag(4, [apic(4, 4, png), apic(4, 3, jpeg)]));
    expect(await bytesOf(v4)).toEqual(jpeg);
    expect(v4?.type).toBe("image/jpeg");
    // Any picture, without a front cover.
    expect(await bytesOf(coverFromTag(tag(3, [apic(3, 0, png)])))).toEqual(png);
    // No tag, or a tag without pictures.
    expect(coverFromTag(new Uint8Array([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(coverFromTag(tag(3, []))).toBeNull();
  });

  test("bundles each page's code with every chunk it imports", async () => {
    const { manifest, files } = await bundle();
    const client = join(import.meta.dir, "..", "..", "src", "web", "client");
    const scripts = (folder: string) =>
      readdirSync(join(client, folder))
        .filter((name) => name.endsWith(".js"))
        .map((name) => name.slice(0, -3));
    expect(Object.keys(manifest.files).sort()).toEqual(
      [...scripts("pages"), ...scripts("head"), STYLES, TOKENS].sort(),
    );
    for (const [name, built] of Object.entries(manifest.files)) {
      expect(files.has(built.file), name).toBe(true);
      for (const chunk of built.preload) expect(files.has(chunk), chunk).toBe(true);
      // A classic script runs as it is: no import or export left in it.
      if (built.kind === "classic") {
        const code = new TextDecoder().decode(defined(files.get(built.file), name).body);
        expect(code).not.toMatch(/^import|\bexport\s*[{*]/m);
      }
      // k.mjs's command line is no page's (KUROBAKO_PAGE leaves it out).
      if (built.kind === "module") {
        const code = new TextDecoder().decode(defined(files.get(built.file), name).body);
        expect(code, name).not.toContain("Usage: node k.mjs");
        expect(code, name).not.toContain('import("node:');
      }
    }
    // public/ holds only what is served as it is.
    expect(readdirSync(join(import.meta.dir, "..", "..", "public")).sort()).toEqual(
      [...FIXED_FILES, ...ICON_FILES, "_headers"].sort(),
    );
  });

  test("pages Cloudflare serves without the Worker get the Worker's security headers", async () => {
    const headers = await Bun.file(join(import.meta.dir, "..", "..", "public", "_headers")).text();
    const block = /^\/k\/\*\n((?: {2}.+\n?)+)/m.exec(headers)?.[1] ?? "";
    const parsed = Object.fromEntries(
      block
        .trim()
        .split("\n")
        .map((line) =>
          line
            .trim()
            .split(/: (.*)/s)
            .slice(0, 2),
        ),
    );
    expect(parsed).toEqual(SECURITY_HEADERS);
  });

  test("the send limit Cloudflare enforces is the one clients are told", async () => {
    const wrangler = await Bun.file(join(import.meta.dir, "..", "..", "wrangler.jsonc")).text();
    const told = /"SENDS_PER_MINUTE":\s*"(\d+)"/.exec(wrangler)?.[1];
    const limiter =
      /"UPLOAD_LIMITER"[^}]*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/.exec(wrangler);
    expect(limiter?.[2]).toBe("60");
    expect(told).toBe(limiter?.[1]);
  });

  test("compose passes every setting on to the server", async () => {
    const root = join(import.meta.dir, "..", "..");
    const read = (path: string) => Bun.file(join(root, path)).text();
    const names = (text: string, pattern: RegExp) =>
      new Set([...text.matchAll(pattern)].map((match) => match[1] as string));
    const read_ = [
      ...names(await read("src/config.ts"), /(?:integer|flag)\(\s*vars,\s*"([A-Z0-9_]+)"/g),
      ...names(await read("src/config.ts"), /vars\.([A-Z0-9_]+)/g),
      ...names(
        await read("src/infrastructure/bun/server.ts"),
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
    const wrangler = await Bun.file(join(import.meta.dir, "..", "..", "wrangler.jsonc")).text();
    const told = /"MISSES_PER_MINUTE":\s*"(\d+)"/.exec(wrangler)?.[1];
    const limiter =
      /"MISS_LIMITER"[^}]*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/.exec(wrangler);
    expect(limiter?.[2]).toBe("60");
    expect(told).toBe(limiter?.[1]);
    expect(told).toBe(String(loadConfig({}).missesPerMinute));
  });

  test("the protocol page's test vectors: computed here, and opened by k.mjs", async () => {
    const page = await Bun.file(
      join(import.meta.dir, "..", "..", "src", "web", "server", "documents", "protocol.html"),
    ).text();
    const vector = (name: string) => {
      const value = new RegExp(`data-vector="${name}">([^<]*)<`).exec(page)?.[1];
      return defined(value, `the ${name} vector`).replaceAll("&quot;", '"');
    };
    // Whitespace JavaScript trims (U+3000, U+FEFF) and keeps (U+0085), a
    // decomposed ば, half-width ﾑｹﾞﾝ and ZWJ emoji must all give the same key.
    const typed = "\u3000\uFEFF Koma never leaves くろは\u3099こ 🐈\u200D⬛📦 ﾑｹﾞﾝ♾\uFE0F\u0085 \t";
    const name = Buffer.from(vector("name"), "hex");
    expect(name.toString("utf8")).toBe(typed.normalize("NFC").trim());
    expect(typed.normalize("NFC").trim().length).toBe(37);

    const secret = pbkdf2Sync(name, "kurobako/v4", 600_000, 32, "sha256");
    expect(secret.toString("hex")).toBe(vector("pbkdf2"));
    const derive = (info: string) =>
      Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, 16));
    const writeKey = derive("kurobako/v4/write");
    const id = createHash("sha256").update(writeKey.toString("base64url")).digest().subarray(0, 16);
    const namespaceKey = derive("kurobako/v4/namespace");
    expect(id.toString("base64url")).toBe(vector("id"));
    expect(namespaceKey.toString("hex")).toBe(vector("namespace-key"));
    expect(writeKey.toString("base64url")).toBe(vector("write-key"));
    expect(Buffer.concat([id, namespaceKey]).toString("base64url")).toBe(vector("read-token"));

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
    const kek = await crypto.subtle.importKey("raw", namespaceKey, "AES-KW", false, ["wrapKey"]);
    const plainKey = await crypto.subtle.importKey("raw", itemKey, "AES-GCM", true, ["encrypt"]);
    const wrapped = await crypto.subtle.wrapKey("raw", plainKey, kek, "AES-KW");
    expect(Buffer.from(wrapped).toString("base64url")).toBe(vector("wrapped"));
    expect(seal(itemKey, 0x20, "kurobako/v4/metadata", Buffer.from(vector("metadata")))).toBe(
      vector("sealed-metadata"),
    );
    const sealBody = (key: Buffer, contents: Uint8Array) => {
      const count = Math.ceil(contents.length / 65_536);
      return Buffer.concat(
        Array.from({ length: count }, (_, index) => {
          const nonce = Buffer.alloc(12);
          nonce.writeUIntBE(index, 5, 6);
          nonce[11] = index === count - 1 ? 1 : 0;
          const cipher = createCipheriv("aes-128-gcm", key, nonce);
          const piece = contents.subarray(index * 65_536, (index + 1) * 65_536);
          return Buffer.concat([cipher.update(piece), cipher.final(), cipher.getAuthTag()]);
        }),
      );
    };
    const bodyKeyBytes = Buffer.from(
      hkdfSync("sha256", itemKey, Buffer.alloc(0), "kurobako/v4/body/0", 16),
    );
    expect(bodyKeyBytes.toString("hex")).toBe(vector("body-key"));
    expect(sealBody(bodyKeyBytes, Buffer.from("hello")).toString("base64url")).toBe(vector("body"));
    const replacementId = vector("replacement-body-id");
    expect(Buffer.from(replacementId, "base64url")).toEqual(Buffer.alloc(16, 1));
    expect(
      seal(itemKey, 0x20, "kurobako/v4/metadata", Buffer.from(vector("replacement-metadata"))),
    ).toBe(vector("sealed-replacement-metadata"));
    const replacementKey = Buffer.from(
      hkdfSync("sha256", itemKey, Buffer.alloc(0), `kurobako/v4/body/1/${replacementId}`, 16),
    );
    expect(replacementKey.toString("hex")).toBe(vector("replacement-body-key"));
    expect(sealBody(replacementKey, Buffer.from("edited")).toString("base64url")).toBe(
      vector("replacement-body"),
    );
    const long = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
    const longBody = sealBody(bodyKeyBytes, long);
    expect(longBody.byteLength).toBe(70_032);
    expect(createHash("sha256").update(longBody).digest("hex")).toBe(vector("long-body-sha256"));

    // k.mjs agrees: the same ID, and it opens what the page shows.
    const space = await openSealedSpace(typed);
    expect(space.id).toBe(vector("id"));
    expect(space.writeKey).toBe(vector("write-key"));
    expect(space.readToken).toBe(vector("read-token"));
    // A read-only link opens the same namespace, with no key to write.
    const reader = await openReadOnlySpace(vector("read-token"));
    expect(reader.id).toBe(vector("id"));
    expect(reader.writeKey).toBeNull();
    const header = `${vector("wrapped")}.${vector("sealed-metadata")}`;
    const sealedSize = Buffer.from(vector("body"), "base64url").byteLength;
    expect(sealedSize).toBe(21);
    const item = await space.openItem(header, sealedSize);
    expect(item.keyText).toBe(vector("item-key-text"));
    expect(item.metadata).toEqual({ kind: "text", title: "hello", size: 5, rev: 0 });
    const opened = await openSharedItem(vector("item-key-text"), header, sealedSize);
    const body = await opened.open(Buffer.from(vector("body"), "base64url"));
    expect(new TextDecoder().decode(body)).toBe("hello");
    expect(contentSize(70_032)).toBe(70_000);
    // The namespace page's limit for encrypted files is the same arithmetic.
    for (const bytes of [0, 1, 65_552, 65_553, 100_000_000])
      expect(sealedFileLimit(bytes)).toBe(contentSize(bytes));
    expect(new Uint8Array(await opened.open(longBody))).toEqual(long);
    // A part opens on its own, as a Range request brings it: here the second segment.
    const key = await bodyKey(itemKey, 0);
    expect(new Uint8Array(await openSegments(key, longBody.subarray(65_552), 1, true))).toEqual(
      long.subarray(65_536),
    );
    // A body cut short, or a segment put elsewhere, does not open.
    await expect(opened.open(longBody.subarray(0, 65_552))).rejects.toThrow();
    await expect(openSegments(key, longBody.subarray(65_552), 0, true)).rejects.toThrow();
    await expect(opened.open(new Uint8Array())).rejects.toThrow();
    await expect(openSegments(key, longBody.subarray(0, 20), 0, false)).rejects.toThrow();
    const replacementKeyJs = await bodyKey(itemKey, 1, replacementId);
    expect(
      new TextDecoder().decode(
        await openSegments(replacementKeyJs, Buffer.from(vector("replacement-body"), "base64url")),
      ),
    ).toBe("edited");
    const replaced = await space.openItem(
      `${vector("wrapped")}.${vector("sealed-replacement-metadata")}`,
      Buffer.from(vector("replacement-body"), "base64url").byteLength,
    );
    expect(replaced.metadata).toEqual({
      kind: "text",
      title: "edited",
      size: 6,
      rev: 1,
      bodyId: replacementId,
    });
    expect(
      new TextDecoder().decode(
        await replaced.open(Buffer.from(vector("replacement-body"), "base64url")),
      ),
    ).toBe("edited");
    await expect(bodyKey(itemKey, 1)).rejects.toThrow();
    await expect(bodyKey(itemKey, 0, replacementId)).rejects.toThrow();
    const missingBodyId = seal(itemKey, 0x20, "kurobako/v4/metadata", Buffer.from('{"rev":1}'));
    await expect(space.openItem(`${vector("wrapped")}.${missingBodyId}`, 22)).rejects.toThrow();

    // Not even contents that read as metadata, which would otherwise pass.
    const lookalike = Buffer.from(JSON.stringify({ filename: "x.exe" }));
    const asMetadata = seal(itemKey, 0x40, "kurobako/v4/metadata", lookalike);
    expect((await space.openItem(`${vector("wrapped")}.${asMetadata}`, 48)).metadata).toMatchObject(
      {
        kind: "file",
        filename: "x.exe",
      },
    );
    const asBody = sealBody(bodyKeyBytes, lookalike).toString("base64url");
    await expect(space.openItem(`${vector("wrapped")}.${asBody}`, 48)).rejects.toThrow();
    await expect(
      opened.open(Buffer.from(vector("sealed-metadata"), "base64url")),
    ).rejects.toThrow();
  });

  test("file types and names: k.mjs describes files as the server does", () => {
    const head = (...bytes: number[]) => new Uint8Array([...bytes, ...new Array(12).fill(0)]);
    const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
    const svg = (text: string) => new TextEncoder().encode(text);
    const samples = [
      head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      head(0xff, 0xd8, 0xff, 0xe0),
      head(...ascii("GIF89a")),
      head(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")),
      head(0, 0, 0, 0x1c, ...ascii("ftypavif")),
      head(0, 0, 0, 0x1c, ...ascii("ftypheic")),
      head(0, 0, 0, 0x1c, ...ascii("ftypisom")),
      head(0, 0, 0, 0x1c, ...ascii("ftypmp42")),
      head(0, 0, 0, 0x14, ...ascii("ftypqt  ")),
      head(0, 0, 0, 0x1c, ...ascii("ftypM4A ")),
      // Matroska and WebM: the EBML header, its DocType inside.
      head(
        0x1a,
        0x45,
        0xdf,
        0xa3,
        0x9f,
        0x42,
        0x86,
        0x81,
        0x01,
        0x42,
        0x82,
        0x88,
        ...ascii("matroska"),
      ),
      head(
        0x1a,
        0x45,
        0xdf,
        0xa3,
        0x9f,
        0x42,
        0x86,
        0x81,
        0x01,
        0x42,
        0x82,
        0x84,
        ...ascii("webm"),
      ),
      head(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...ascii("nope")),
      head(...ascii("ID3"), 4, 0, 0),
      head(...ascii("fLaC")),
      head(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")),
      head(...ascii("%PDF-1.7")),
      new Uint8Array([0x89, 0x50]),
      svg('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      svg(
        '\uFEFF<?xml version="1.0"?>\n<!-- by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg\tviewBox="0 0 1 1">',
      ),
      // Entities are no image's business.
      svg('<!DOCTYPE svg [<!ENTITY a "b">]><svg>'),
      svg("<html><svg>"),
      svg("<svgs>"),
      // Past the first 1024 bytes, nothing is looked at.
      svg(`<!-- ${"x".repeat(1100)} --><svg>`),
    ];
    const kinds = samples.map((bytes) => detectMedia(bytes)?.extension ?? null);
    expect(kinds).toEqual([
      "png",
      "jpg",
      "gif",
      "webp",
      "avif",
      "heic",
      "mp4",
      "mp4",
      "mov",
      "m4a",
      "mkv",
      "webm",
      null,
      "mp3",
      "flac",
      "wav",
      null,
      null,
      "svg",
      "svg",
      null,
      null,
      null,
      null,
    ]);
    for (const bytes of samples) {
      const server = detectMedia(bytes);
      expect(cliDetectMedia(bytes)).toEqual(server);
      for (const name of ["photo.jpeg", "Report 2024.pdf", "", "-rf", "a/b/c.tar.gz", "noext"]) {
        const expected = server
          ? safeMediaName(name || "file", server.extension, server.kind)
          : safeFileName(name || "file");
        expect(fileMetadata(bytes, name)).toMatchObject({
          filename: expected,
          mime: server?.mime ?? "application/octet-stream",
        });
      }
    }
    expect(CLI_TEXT_PREVIEW_CHARS).toBe(TEXT_PREVIEW_CHARS);
  });

  test("bundles: a tar any tool reads, told the same way by the server and k.mjs", () => {
    const encoder = new TextEncoder();
    const entries = [
      { path: "notes.md", type: "text/markdown", text: true, bytes: encoder.encode("# hi") },
      { path: "olá.txt", type: "text/plain", text: true, bytes: encoder.encode("x".repeat(600)) },
      { path: "photo.png", type: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    ];
    const bytes = writeBundle({ main: "olá.txt", entries, mtime: 0 });
    expect(bytes.length % 512).toBe(0);
    expect(isBundle(bytes)).toBe(true);
    const back = readBundle(bytes);
    expect(back.main).toBe("olá.txt");
    expect(back.entries).toEqual(entries.map((entry) => ({ text: false, ...entry })));
    // k.mjs, which seals an encrypted namespace's files, types it the same.
    expect(CLI_BUNDLE_MIME).toBe(BUNDLE_MIME);
    expect(fileMetadata(bytes, "notes")).toMatchObject({
      mime: BUNDLE_MIME,
      filename: "notes.tar",
    });
    expect(fileMetadata(bytes.slice(512), "notes").mime).toBe("application/octet-stream");
    expect(uniqueNames(["a.png", "a.png", "kurobako.json"])).toEqual([
      "a.png",
      "a-2.png",
      "kurobako-2.json",
    ]);
    expect(() => readBundle(new Uint8Array(1024))).toThrow("not a bundle");
  });

  test("the protocol's version: k.mjs speaks the server's", () => {
    expect(K_PROTOCOL).toBe(PROTOCOL_VERSION);
  });

  test("versions: k.mjs says which server version it comes from", async () => {
    const pkg = (await Bun.file(join(import.meta.dir, "..", "..", "package.json")).json()) as {
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
