// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Bundles the browser's code in public/ (see ENTRIES): each page's script and
// the chunks the pages share, minified, named by their contents, with source
// maps. The Bun server does it in memory when it starts (it takes milliseconds);
// for Cloudflare, ops/build.ts writes the result into dist/.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ENTRIES, type Manifest, STYLES } from "../pages";

export const PUBLIC_DIR = join(import.meta.dir, "../../public");

export type BuiltFile = { body: Uint8Array; type: string };
export type Bundle = {
  manifest: Manifest;
  /** By name in ASSETS_PATH. */
  files: Map<string, BuiltFile>;
};

const named = (path: string) => path.replace(/^\.\//, "");
const contentHash = (body: Uint8Array | string) =>
  createHash("sha256").update(body).digest("hex").slice(0, 12);

const build = async (
  entrypoints: readonly string[],
  options: { format: "esm" | "iife"; splitting: boolean },
) => {
  const result = await Bun.build({
    entrypoints: entrypoints.map((entry) => join(PUBLIC_DIR, entry)),
    root: PUBLIC_DIR,
    target: "browser",
    minify: true,
    sourcemap: "linked",
    metafile: true,
    naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]" },
    ...options,
  });
  if (!result.success) throw new AggregateError(result.logs, "The browser's code did not build.");
  return result;
};

export const bundle = async (): Promise<Bundle> => {
  const files = new Map<string, BuiltFile>();
  const manifest: Manifest = { build: "", files: {} };

  for (const [kind, options] of [
    ["module", { format: "esm", splitting: true }],
    // Classic scripts stand alone: no imports, no chunks.
    ["classic", { format: "iife", splitting: false }],
  ] as const) {
    const result = await build(ENTRIES[kind], options);
    for (const output of result.outputs) {
      files.set(named(output.path), {
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
    for (const [file, output] of Object.entries(outputs)) {
      if (!output.entryPoint) continue;
      const entry = output.entryPoint.replace(/^public\//, "");
      // k.mjs's Node imports become chunks of their own; no page loads them.
      if (!(ENTRIES[kind] as readonly string[]).includes(entry)) continue;
      manifest.files[entry] = { file: named(file), kind, preload: [...imported(file)].map(named) };
    }
  }

  // tokens.css then styles.css, as one file: one request that blocks the paint.
  const css = (
    await Promise.all(ENTRIES.style.map((path) => Bun.file(join(PUBLIC_DIR, path)).text()))
  ).join("\n");
  const cssFile = `styles-${contentHash(css)}.css`;
  files.set(cssFile, { body: new TextEncoder().encode(css), type: "text/css;charset=utf-8" });
  manifest.files[STYLES] = { file: cssFile, kind: "style", preload: [] };

  for (const entry of [...ENTRIES.module, ...ENTRIES.classic]) {
    if (!manifest.files[entry]) throw new Error(`The build has no file for public/${entry}.`);
  }
  manifest.build = contentHash([...files.keys()].sort().join("\n"));
  return { manifest, files };
};
