// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Run by `bun pm version`, so package.json and public/k.mjs never disagree.
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const { version } = (await Bun.file(join(root, "package.json")).json()) as { version: string };
const file = Bun.file(join(root, "public", "k.mjs"));
const source = await file.text();
const pattern = /^export const VERSION = "[^"]*";$/m;
if (!pattern.test(source)) throw new Error("public/k.mjs has no VERSION line.");
await Bun.write(file, source.replace(pattern, `export const VERSION = "${version}";`));
