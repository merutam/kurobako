// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Everything in dist/ is served before the Worker runs; the rest comes here.
import { createApp } from "../../app";
import { ASSETS_PATH, isAssetPath, isFixedFile, loadAssets, MANIFEST_FILE } from "../../assets";
import { loadConfig } from "../../config";
import { sitePath } from "../../core/routing";
import { CLOUDFLARE_LIMITS } from "./limits";
import { createCloudflarePlatform } from "./platform";

export { HubObject, NamespaceObject } from "./objects";

const readManifest = (assets: Fetcher) => async () => {
  const path = `${ASSETS_PATH}/${MANIFEST_FILE}`;
  const response = await assets.fetch(new Request(`https://assets.invalid${path}`));
  if (!response.ok)
    throw new Error(`Missing dist${path}: run ops/build.ts (HTTP ${response.status}).`);
  return response.text();
};

const buildApp = async (env: Env) => {
  const config = loadConfig(env, CLOUDFLARE_LIMITS);
  const app = createApp(
    config,
    await loadAssets(readManifest(env.ASSETS)),
    createCloudflarePlatform(env),
  );
  return { app, basePath: config.basePath };
};

// Config, assets and bindings only change with a new deployment.
let app: ReturnType<typeof buildApp> | null = null;

export default {
  async fetch(request, env, ctx) {
    app ??= buildApp(env).catch((error: unknown) => {
      app = null;
      throw error;
    });
    const { app: built, basePath } = await app;
    // Under a base path, asset URLs (/k/k/assets/…) find no asset and land here; so do the tests.
    const inside = sitePath(basePath, new URL(request.url).pathname);
    if (inside && (isFixedFile(inside) || isAssetPath(inside))) {
      return env.ASSETS.fetch(new Request(new URL(inside, request.url), request));
    }
    return built.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
