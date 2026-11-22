import { join } from "node:path";
import { Hono } from "hono";

// The launcher builds first. The prototype remains outside the production Worker.
export const startPilot = async ({
  upstream: upstreamUrl,
  port = 3100,
}: {
  upstream: string;
  port?: number;
}) => {
  const renderPath = "./.dist/server/render.js";
  const { render } = (await import(renderPath)) as typeof import("./entry-server");
  const upstream = new URL(upstreamUrl);
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    upstream.search ||
    upstream.hash ||
    upstream.username ||
    upstream.password
  )
    throw new Error("PILOT_UPSTREAM must be an origin and optional base path.");
  const base = upstream.href.replace(/\/$/, "");
  const fetchUpstream = async (path: string, init: RequestInit = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await fetch(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        redirect: "manual",
      });
    } catch {
      return new Response(
        `Backend unavailable at ${base}. Start that Kurobako instance, or unset PILOT_UPSTREAM to use the temporary local demo.`,
        {
          status: 502,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        },
      );
    } finally {
      clearTimeout(timer);
    }
  };
  const app = new Hono();
  app.get("/", (c) => c.redirect("/pilot/example"));
  app.get("/pilot-assets/*", async (c) => {
    const name = c.req.path.slice("/pilot-assets/".length);
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split("/").includes("..")) return c.notFound();
    const file = Bun.file(join(import.meta.dir, ".dist/client", name));
    return (await file.exists()) ? new Response(file) : c.notFound();
  });
  app.all("/api/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname.slice(4);
    if (
      !/^\/[A-Za-z0-9_-]+(?:\/[^/]*)*$/.test(path) ||
      path.startsWith("/k/") ||
      path.startsWith("/e/")
    )
      return c.notFound();
    const response = await fetchUpstream(`${path}${url.search}`, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      redirect: "manual",
    });
    return new Response(response.body, response);
  });
  app.get("/pilot/:namespace", async (c) => {
    const ns = c.req.param("namespace");
    if (!/^[A-Za-z0-9_-]+$/.test(ns) || ["e", "k", "i", "v"].includes(ns)) return c.notFound();
    const response = await fetchUpstream(`/${ns}/ls?summary`, { headers: c.req.raw.headers });
    if (!response.ok) return new Response(response.body, response);
    const items = await response.json();
    const nonce = crypto.randomUUID();
    c.header("Cache-Control", "no-store");
    c.header(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    return c.html(render({ namespace: ns, items, api: `/api/${ns}` }, nonce));
  });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
      throw new Error(
        `Port ${port} is already in use. Try: PILOT_PORT=${port + 1} bun run pilot:start`,
      );
    }
    throw error;
  }
  console.info(`Solid pilot: ${server.url}pilot/example`);
  return server;
};
