// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Convention, nothing to register:
//
//   pages/<name>.js   a page's module (src/pages/<name>.tsx loads it)
//   head/<name>.js    a classic script, run in <head> before the first paint
//   styles/           site.css: tokens.css then styles.css, one minified file
//
// Each page is bundled whole, with only lazy imports apart (highlight.js, QR):
// shared chunks would cost a request per set of pages sharing a module.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { type Manifest, STYLES, TOKENS } from "../assets";

const CLIENT_DIR = import.meta.dir;

export type BuiltFile = { body: Uint8Array; type: string };
export type Bundle = {
  manifest: Manifest;
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
  const manifest: Manifest = { build: "", themes: {}, files: {} };

  for (const [folder, kind, format, splitting] of [
    ["pages", "module", "esm", true],
    // Classic scripts cannot import.
    ["head", "classic", "iife", false],
  ] as const) {
    const entrypoints = scripts(folder);
    for (const group of splitting ? entrypoints.map((entry) => [entry]) : [entrypoints]) {
      const result = await Bun.build({
        entrypoints: group,
        root: CLIENT_DIR,
        target: "browser",
        format,
        splitting,
        minify: true,
        sourcemap: "linked",
        metafile: true,
        // k.mjs's command line imports Node's modules, which no page runs.
        external: ["node:*"],
        // Leaves out k.mjs's command line (see its last lines).
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
      /** Dynamic imports are left out: they load later, if ever. */
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

  // No source map (Bun makes them for scripts only). No renaming, so themes still apply.
  const styles = await Bun.build({
    entrypoints: [join(CLIENT_DIR, "styles", "site.css")],
    minify: true,
    // Served from the site (the logo), not bundled.
    external: ["*.png"],
  });
  if (!styles.success) throw new AggregateError(styles.logs, "The styles did not build.");
  const built = styles.outputs.find((output) => output.path.endsWith(".css"));
  if (!built) throw new Error("The styles built into no stylesheet.");
  const css = await built.text();
  const cssFile = `styles-${contentHash(css)}.css`;
  files.set(cssFile, { body: new TextEncoder().encode(css), type: "text/css;charset=utf-8" });
  manifest.files[STYLES] = { file: cssFile, kind: "style", preload: [] };

  // As written, so /k/theme can start a theme from it.
  const tokens = await Bun.file(join(CLIENT_DIR, "styles", "tokens.css")).text();
  const tokensFile = `tokens-${contentHash(tokens)}.css`;
  files.set(tokensFile, { body: new TextEncoder().encode(tokens), type: "text/css;charset=utf-8" });
  manifest.files[TOKENS] = { file: tokensFile, kind: "style", preload: [] };

  // In the manifest, so both servers put them into /k/theme without reading files.
  const themesDir = join(CLIENT_DIR, "styles", "themes");
  for (const name of readdirSync(themesDir)
    .filter((name) => name.endsWith(".css"))
    .sort()) {
    manifest.themes[name] = await Bun.file(join(themesDir, name)).text();
  }

  manifest.build = contentHash(
    [...files.keys()].sort().join("\n") + JSON.stringify(manifest.themes),
  );
  return { manifest, files };
};
