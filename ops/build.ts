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
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { bundle, PUBLIC_DIR } from "../src/bun/bundle";
import {
  ASSETS_PATH,
  FIXED_FILES,
  ICON_FILES,
  loadAssets,
  MANIFEST_FILE,
  STATIC_PAGES,
  siteViewOf,
} from "../src/pages";
import { renderLicensesPage, renderProtocolPage } from "../src/views/documents";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const assetsDir = join(dist, ASSETS_PATH);

await rm(dist, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

const { manifest, files } = await bundle();
for (const [name, file] of files) await Bun.write(join(assetsDir, name), file.body);
await Bun.write(join(assetsDir, MANIFEST_FILE), JSON.stringify(manifest));
for (const name of [...FIXED_FILES, ...ICON_FILES, "_headers"]) {
  await cp(join(PUBLIC_DIR, name), join(dist, name));
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
  for (const page of STATIC_PAGES) await Bun.write(join(dist, `${page}.html`), render[page](site));
}
