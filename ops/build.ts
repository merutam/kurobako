// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Builds dist/, what Cloudflare serves without running the Worker (assets in
// wrangler.jsonc): the browser's code bundled into k/assets/ with its
// manifest, the fixed files (sw.js, k.mjs, the icons), _headers, and the
// pages that never change (the protocol and the licenses). Wrangler runs it
// before `dev` and `deploy` (build.command); `bun run test` too. dist/ is not
// committed. The Bun server needs none of it: it bundles in memory.
//
// The static pages are only for a site at the domain's root. Under a
// BASE_PATH (wrangler.jsonc's vars, or the environment the build runs in; not
// .env, see --no-env-file), an asset at /k/protocol would hide that path from
// the Worker, which may need it (with BASE_PATH=/k, it is the namespace
// /protocol): then there are none, and the Worker renders them itself, as it
// does wherever they are missing.
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
import { renderLicensesPage, renderProtocolPage } from "../src/pages/documents";

const root = join(import.meta.dir, "..");
const publicDir = join(root, "public");
const dist = join(root, "dist");
const assetsDir = join(dist, ASSETS_PATH);

/** Every file written, so what is left from an earlier build can go. */
const written = new Set<string>();
const write = async (path: string, body: Uint8Array | string) => {
  await Bun.write(path, body);
  written.add(path);
};

const { manifest, files } = await bundle();
for (const [name, file] of files) await write(join(assetsDir, name), file.body);
// Last of the bundle: a server reading it finds every file it names.
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
  // The protocol and the licenses read no config.
  const site = siteViewOf(assets, "", null);
  const render = { "k/protocol": renderProtocolPage, "k/licenses": renderLicensesPage };
  for (const page of STATIC_PAGES) await write(join(dist, `${page}.html`), render[page](site));
}

// Written over, never emptied first: a `wrangler dev` serving dist/ meanwhile
// never sees it half gone.
for (const path of await readdir(dist, { recursive: true })) {
  const full = join(dist, path);
  if (!written.has(full) && (await stat(full)).isFile()) await rm(full);
}
