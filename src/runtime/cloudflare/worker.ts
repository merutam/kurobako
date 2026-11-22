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

// Config, assets and bindings only change with a new deployment, so the built
// app is kept. The app, never the promise that builds it: a Worker may not
// await a promise that another, finished request created
// (handle_cross_request_promise_resolution, on since the 2026-10-03
// compatibility date), so concurrent cold requests each build and the last
// one to finish is kept. A failed build is not kept at all.
let app: Awaited<ReturnType<typeof buildApp>> | null = null;

export default {
  async fetch(request, env, ctx) {
    app ??= await buildApp(env);
    const { app: built, basePath } = app;
    // Under a base path, asset URLs (/k/k/assets/…) find no asset and land here; so do the tests.
    const inside = sitePath(basePath, new URL(request.url).pathname);
    if (inside && (isFixedFile(inside) || isAssetPath(inside))) {
      return env.ASSETS.fetch(new Request(new URL(inside, request.url), request));
    }
    return built.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
