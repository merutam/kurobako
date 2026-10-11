// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Bundles the browser's code. By convention, nothing to register:
//
//   pages/<name>.js   a page's script, a module (src/pages/<name>.tsx loads it)
//   head/<name>.js    a classic script, run in <head> before the first paint
//                     (head/parts/ holds what they bundle)
//   styles/           tokens.css then styles.css, as one file
//
// Each is named in the manifest by <name> ("namespace", "site", "styles").
// Files are minified, named by their contents and come with source maps. Each
// page is bundled on its own: everything it imports comes in its one file,
// and only what it loads later (highlight.js, the QR code) apart. Shared
// chunks would save a little when going from page to page, at the price of a
// request for each set of pages sharing a module, some of a few hundred bytes.
// The Bun server bundles in memory when it starts (it takes milliseconds);
// for Cloudflare, ops/build.ts writes the result into dist/.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { type Manifest, STYLES } from "../assets";

const CLIENT_DIR = import.meta.dir;
/** The styles, in the order they apply. */
const STYLE_FILES = ["tokens.css", "styles.css"];

export type BuiltFile = { body: Uint8Array; type: string };
export type Bundle = {
  manifest: Manifest;
  /** By name in ASSETS_PATH. */
  files: Map<string, BuiltFile>;
};

const scripts = (folder: string) =>
  readdirSync(join(CLIENT_DIR, folder))
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(CLIENT_DIR, folder, name));
const nameOf = (path: string) => basename(path).replace(/\.js$/, "");
const outputName = (path: string) => path.replace(/^\.\//, "");
const contentHash = (body: Uint8Array | string) =>
  createHash("sha256").update(body).digest("hex").slice(0, 12);

export const bundle = async (): Promise<Bundle> => {
  const files = new Map<string, BuiltFile>();
  const manifest: Manifest = { build: "", files: {} };

  for (const [folder, kind, format, splitting] of [
    ["pages", "module", "esm", true],
    // Classic scripts stand alone: no imports, no chunks.
    ["head", "classic", "iife", false],
  ] as const) {
    const entrypoints = scripts(folder);
    for (const group of splitting ? entrypoints.map((entry) => [entry]) : [entrypoints]) {
      const result = await Bun.build({
        entrypoints: group,
        root: CLIENT_DIR,
        target: "browser",
        format,
        // Only for what a page imports later: it imports nothing else apart.
        splitting,
        minify: true,
        sourcemap: "linked",
        metafile: true,
        // k.mjs's command line imports Node's modules, which no page runs.
        external: ["node:*"],
        // No page runs k.mjs's command line: this leaves it out (see its last lines).
        define: { KUROBAKO_PAGE: "true" },
        naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]" },
      });
      if (!result.success)
        throw new AggregateError(result.logs, "The browser's code did not build.");
      for (const output of result.outputs) {
        files.set(outputName(output.path), {
          body: new Uint8Array(await output.arrayBuffer()),
          type: output.type,
        });
      }

      const outputs = result.metafile?.outputs ?? {};
      /** What a file imports, all the way down; dynamic imports load later, if ever. */
      const imported = (file: string, seen = new Set<string>()) => {
        for (const { path, kind } of outputs[file]?.imports ?? []) {
          if (kind !== "import-statement" || seen.has(path)) continue;
          seen.add(path);
          imported(path, seen);
        }
        return seen;
      };
      const names = new Set(group.map(nameOf));
      for (const [file, output] of Object.entries(outputs)) {
        const name = output.entryPoint && nameOf(output.entryPoint);
        // What a page imports later is an entry of its own, named after its module.
        if (!name || !names.has(name)) continue;
        if (manifest.files[name]) throw new Error(`Two of the client's scripts are named ${name}.`);
        manifest.files[name] = {
          file: outputName(file),
          kind,
          preload: [...imported(file)].map(outputName),
        };
      }
    }
  }

  const css = (
    await Promise.all(STYLE_FILES.map((name) => Bun.file(join(CLIENT_DIR, "styles", name)).text()))
  ).join("\n");
  const cssFile = `styles-${contentHash(css)}.css`;
  files.set(cssFile, { body: new TextEncoder().encode(css), type: "text/css;charset=utf-8" });
  manifest.files[STYLES] = { file: cssFile, kind: "style", preload: [] };

  manifest.build = contentHash([...files.keys()].sort().join("\n"));
  return { manifest, files };
};
