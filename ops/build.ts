// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// dist/ is what Cloudflare serves without running the Worker; Wrangler runs
// this before `dev` and `deploy`. The Bun server needs none of it.
//
// Static pages only at the domain's root: under a BASE_PATH, an asset at
// /k/protocol would hide that path from the Worker (it could be a namespace).
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ASSETS_PATH,
  FIXED_FILES,
  ICON_FILES,
  loadAssets,
  MANIFEST_FILE,
  STATIC_PAGES,
  siteViewOf,
} from "../src/assets";
import { bundle } from "../src/client/build";
import { STATIC_PAGE_RENDERERS } from "../src/pages/documents";

const root = join(import.meta.dir, "..");
const publicDir = join(root, "public");
const dist = join(root, "dist");
const assetsDir = join(dist, ASSETS_PATH);

/** So files left from an earlier build can be removed. */
const written = new Set<string>();
const write = async (path: string, body: Uint8Array | string) => {
  await Bun.write(path, body);
  written.add(path);
};

const { manifest, files } = await bundle();
for (const [name, file] of files) await write(join(assetsDir, name), file.body);
// Last, so a server reading it finds every file it names.
await write(join(assetsDir, MANIFEST_FILE), JSON.stringify(manifest));
for (const name of [...FIXED_FILES, ...ICON_FILES, "_headers"]) {
  await write(join(dist, name), await Bun.file(join(publicDir, name)).bytes());
}

const wrangler = await Bun.file(join(root, "wrangler.jsonc")).text();
const basePath =
  process.env.BASE_PATH?.trim() || /"BASE_PATH":\s*"([^"]*)"/.exec(wrangler)?.[1]?.trim();
if (basePath) {
  console.log(`BASE_PATH is ${basePath}: the Worker renders the protocol and the licenses.`);
} else {
  const assets = await loadAssets(async () => JSON.stringify(manifest));
  const site = siteViewOf(assets, "", null);
  for (const page of STATIC_PAGES) {
    await write(join(dist, `${page}.html`), STATIC_PAGE_RENDERERS[page](site));
  }
}

// Written over, never emptied first, so a running `wrangler dev` never sees it half gone.
for (const path of await readdir(dist, { recursive: true })) {
  const full = join(dist, path);
  if (!written.has(full) && (await stat(full)).isFile()) await rm(full);
}
