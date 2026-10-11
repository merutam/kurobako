// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Bundles the browser's code. By convention, nothing to register:
//
//   pages/<name>.js   a page's script, a module (src/pages/<name>.tsx loads it)
//   head/<name>.js    a classic script, run in <head> before the first paint
//   styles/           tokens.css then styles.css, as one file
//
// Each is named in the manifest by <name> ("namespace", "theme", "styles").
// Files are minified, named by their contents and come with source maps; the
// chunks pages share are split out, and each page preloads those it imports.
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
    const result = await Bun.build({
      entrypoints,
      root: CLIENT_DIR,
      target: "browser",
      format,
      splitting,
      minify: true,
      sourcemap: "linked",
      metafile: true,
      naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]" },
    });
    if (!result.success) throw new AggregateError(result.logs, "The browser's code did not build.");
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
    const names = new Set(entrypoints.map(nameOf));
    for (const [file, output] of Object.entries(outputs)) {
      const name = output.entryPoint && nameOf(output.entryPoint);
      // k.mjs's Node imports become entries of their own; no page loads them.
      if (!name || !names.has(name)) continue;
      if (manifest.files[name]) throw new Error(`Two of the client's scripts are named ${name}.`);
      manifest.files[name] = {
        file: outputName(file),
        kind,
        preload: [...imported(file)].map(outputName),
      };
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
