// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Renders the pages that are the same for every request and every instance
// (the protocol and the licenses) into public/k/, so Cloudflare serves them as
// static assets, without running the Worker. Wrangler runs it before `dev` and
// `deploy` (build.command in wrangler.jsonc); the files are not committed.
//
// Only for a site at the domain's root. Under a BASE_PATH (wrangler.jsonc's
// vars, or the environment the build runs in; not .env, see --no-env-file), an
// asset at /k/protocol would hide that path from the Worker, which may need it
// (with BASE_PATH=/k, it is the namespace /protocol): then there are no files,
// and the Worker renders the pages itself, as it does wherever they are missing.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadAssets, STATIC_PAGES, siteViewOf } from "../src/pages";
import { renderLicensesPage, renderProtocolPage } from "../src/views/documents";

const root = join(import.meta.dir, "..");
const publicDir = join(root, "public");
const wrangler = await Bun.file(join(root, "wrangler.jsonc")).text();
const basePath =
  process.env.BASE_PATH?.trim() || /"BASE_PATH":\s*"([^"]*)"/.exec(wrangler)?.[1]?.trim();

await rm(join(publicDir, "k"), { recursive: true, force: true });
if (basePath) {
  console.log(`BASE_PATH is ${basePath}: the Worker renders the protocol and the licenses.`);
} else {
  const assets = await loadAssets((path) => Bun.file(join(publicDir, path)).text());
  // The protocol and the licenses read no config.
  const site = siteViewOf(assets, "", null);
  const render = { "k/protocol": renderProtocolPage, "k/licenses": renderLicensesPage };
  for (const page of STATIC_PAGES) {
    await Bun.write(join(publicDir, `${page}.html`), render[page](site));
  }
}
