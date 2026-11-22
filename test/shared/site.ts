// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { defined } from "../support";
import type { Harness } from "./index";
import type { PublicConfig, Tools } from "./tools";

export const siteTests = (harness: Harness, tools: Tools) => {
  const { describe, test, expect, call, config, adminKey } = harness;
  const { json, sendText, fresh } = tools;
  describe("live updates", () => {
    test("require a WebSocket upgrade", async () => {
      expect((await call(`/${fresh()}/live`)).status).toBe(426);
    });
  });

  describe("site", () => {
    test("assembles pages: bundled scripts, footer and the embedded config", async () => {
      const html = await (await call(`/${fresh()}`)).text();
      // One file with everything it imports, so nothing to preload and no import left.
      const script = html.match(
        /<script type="module" src="(\/k\/assets\/namespace-[0-9a-z]+\.js)"/,
      )?.[1];
      const response = await call(defined(script, "the namespace page's script"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
      expect(html).not.toContain('rel="modulepreload"');
      const code = await response.text();
      expect(code).not.toMatch(/\bfrom\s*"\.\//);
      // What it loads later (highlight.js, the QR code) is there to load.
      const later = [...code.matchAll(/import\("\.\/([^"]+\.js)"\)/g)];
      expect(later.length).toBeGreaterThan(0);
      for (const [, file] of later) {
        expect((await call(`/k/assets/${defined(file, "a later file")}`)).status).toBe(200);
      }
      expect(html).toMatch(/\(build [0-9a-f]{12}\)/);
      expect(html.match(/<input id="[a-z-]+" class="file-drop"/g)).toHaveLength(2);
      // The limits come written: the page's script does not fill them in.
      expect(html).toContain('<option value="">Instance default (1 day)</option>');
      // Expiry is each item's: the namespace does not claim one.
      expect(html).not.toContain("expiry-label");
      expect(html).toMatch(/id="file-limit" class="hint">Any files, up to \d+ at once/);
      expect(html).toContain('<input id="burn" type="checkbox"/>');
      expect(html).toContain('id="media-feed-list"');
      expect(html).not.toContain("%MEDIA_FEED%");
      expect(html).not.toContain('id="reads-limit"');
      const home = await (await call("/")).text();
      expect(home).toContain(
        '<span id="namespace-prefix" class="namespace-prefix" aria-hidden="true">/e#</span>',
      );
      expect(home).toContain('aria-label="Enable end-to-end encryption"');
      expect(home).toContain('id="e2ee-help"');
      expect(home).toContain('id="e2ee-dialog" class="dialog"');
      expect(home).toMatch(
        /href="\/k\/assets\/styles-[0-9a-f]+\.css"[\s\S]*src="\/k\/assets\/site-[0-9a-z]+\.js"/,
      );
      expect(home).toMatch(/id="random-name"[^>]*>Random name<\/button>/);
      expect(home).toContain('href="/stats.json">Full statistics</a>');
      expect(home).toMatch(/class="external-link"[^>]*>Source<\/a>/);
      expect(home).toContain('id="namespace-hint" class="hint">E2EE. Max 256 characters.</p>');
      expect(home).toContain('maxlength="256"');
      expect(home).toContain(
        'id="theme-toggle" class="theme-toggle" type="button" data-theme-choice="auto" hidden',
      );
      expect(home).toContain('id="stats-section" class="stack page-section"');
      expect(home).not.toContain('id="toggle-stats"');
      expect(home).not.toContain("data-stat=");
      expect(home).not.toContain('id="misses-per-minute"');
      expect(home).not.toContain('id="max-storage"');
      expect(home).toContain(`<td id="max-items">${config.maxItems.toLocaleString("en-US")}</td>`);
      expect(home).toContain(
        `<td id="sends-per-minute">${config.sendsPerMinute.toLocaleString("en-US")}</td>`,
      );
      expect(home).not.toContain("%MAX_FILE_SIZE%");

      const embedded = html.match(
        /<script type="application\/json" id="config">(.*?)<\/script>/s,
      )?.[1];
      expect(JSON.parse(defined(embedded, "the embedded config"))).toEqual(
        await json("/.well-known/kurobako"),
      );
    });

    test("controls are words: decorative marks are hidden from assistive technology", async () => {
      const ns = fresh();
      await sendText(ns, "no icons");
      for (const path of ["/", `/${ns}`, `/${ns}/log`, "/k/protocol", "/k/licenses", "/k/share"]) {
        const html = await (await call(path)).text();
        expect(html, path).not.toContain("data-icon");
        // Three theme states and the decorative site mark.
        expect(html.match(/<svg/g), path).toHaveLength(4);
        expect(html.match(/<svg[^>]*aria-hidden="true"/g), path).toHaveLength(4);
      }
    });

    test("installs as an app whose shares never reach the server", async () => {
      const response = await call("/manifest.webmanifest");
      expect(response.headers.get("content-type")).toContain("application/manifest+json");
      const manifest = (await response.json()) as {
        icons: { src: string; sizes: string; purpose: string }[];
      };
      expect(manifest).toMatchObject({
        start_url: "/",
        scope: "/",
        display: "standalone",
        share_target: { action: "/k/share", method: "POST", enctype: "multipart/form-data" },
      });
      // Every icon is there, at the size it says, and Android gets one to shape.
      expect(manifest.icons.map((icon) => icon.purpose)).toContain("maskable");
      for (const icon of manifest.icons) {
        const image = await call(icon.src);
        expect(image.headers.get("content-type"), icon.src).toBe("image/png");
        const header = new DataView(await image.arrayBuffer());
        expect(`${header.getUint32(16)}x${header.getUint32(20)}`, icon.src).toBe(icon.sizes);
      }
      // Every page links it, and installs the Service Worker that takes shares.
      const home = await (await call("/")).text();
      expect(home).toContain('<link rel="manifest" href="/manifest.webmanifest"/>');
      // In head/site.js, every page's one classic script, before the first paint.
      expect(home).toMatch(/<script src="\/k\/assets\/site-[0-9a-z]+\.js"><\/script>/);
      expect(home.match(/<script src=/g)).toHaveLength(1);
      // Without the Service Worker, a share is turned back unread.
      const form = new FormData();
      form.set("text", "never stored");
      const lost = await call("/k/share", { method: "POST", body: form, redirect: "manual" });
      expect(lost.status).toBe(303);
      expect(lost.headers.get("location")).toBe("/k/share?lost");
      const page = await (await call("/k/share")).text();
      expect(page).toContain('id="share-form"');
      expect(page).toContain('id="share-field" class="namespace-input"');
      expect(page).toContain('id="share-prefix" class="namespace-prefix"');
      expect(page).toContain('id="share-encrypted"');
      expect(page).toContain('id="share-e2ee-dialog"');
      expect(page).toContain('<meta name="robots" content="noindex"/>');
    });

    test("offers one's own theme, from the tokens as written", async () => {
      const page = await (await call("/k/theme")).text();
      expect(page).toContain('id="theme-css"');
      expect(page).toContain('<meta name="robots" content="noindex"/>');
      const presets = JSON.parse(
        defined(
          /<script type="application\/json" id="theme-presets">([^<]+)<\/script>/.exec(page)?.[1],
          "theme presets",
        ),
      ) as Record<string, string>;
      expect(Object.keys(presets).sort()).toEqual([
        "midnight-plum.css",
        "nordic-slate.css",
        "paper-and-ink.css",
        "phosphor-green.css",
        "retro-macintosh.css",
      ]);
      for (const [name, css] of Object.entries(presets)) {
        expect(page).toContain(`data-preset="${name}"`);
        expect(css).toContain(`Palette: ${name.slice(0, -4)}`);
        expect(css).toContain("--accent:");
      }
      // Other pages link to it without carrying the embedded CSS.
      const home = await (await call("/")).text();
      expect(home).toContain('href="/k/theme">Theme</a>');
      expect(home).not.toContain('id="theme-presets"');
      expect(home).not.toContain("Palette: amber-terminal");
      // As written, unlike the minified styles.
      const tokens = defined(/data-tokens="([^"]+)"/.exec(page)?.[1], "the tokens' address");
      const response = await call(tokens);
      expect(response.headers.get("content-type")).toContain("text/css");
      const css = await response.text();
      expect(css).toContain("SPDX-License-Identifier");
      expect(css).toMatch(/\n {2}--accent: light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\);\n/);
    });

    test("offers no notifications without VAPID keys", async () => {
      const ns = fresh("nopush");
      await sendText(ns, "here");
      expect((await json<{ push: unknown }>("/.well-known/kurobako")).push).toBeNull();
      const subscribe = await call(`/${ns}/push`, { method: "POST", body: "{}" });
      expect(subscribe.status).toBe(404);
    });

    test("publishes the project and production dependency licenses separately", async () => {
      const html = await (await call("/k/licenses")).text();
      expect(html).toContain("AGPL-3.0-or-later");
      expect(html).toContain("Hono");
      expect(html).toContain("Highlight.js 11.12.0");
      expect(html).toContain("uQR 0.1.3");
      expect(html).toContain("Garage 2");
      expect(html).toContain("Optional service");
      expect(html).toContain("Full MIT license and notice");
      expect(html).not.toContain("%APP_VERSION%");
    });

    test("exposes the public config the client needs", async () => {
      const body = await json<PublicConfig>("/.well-known/kurobako");
      expect(body).toMatchObject({
        base: "",
        version: expect.any(String),
        protocolUrl: "/k/protocol",
        clientUrl: "/k.mjs",
        maxItems: config.maxItems,
        sendsPerMinute: config.sendsPerMinute,
        inlineTextBytes: config.inlineTextBytes,
        live: { ping: "ping" },
      });
      expect(new RegExp(body.namespace.pattern).test("alpha")).toBe(true);
      expect(body.namespace.reserved).toEqual(["e", "i", "k", "v"]);
    });
  });

  describe("admin dashboard", () => {
    const login = (key: string, ip: string) =>
      call("/k/a/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ key }),
      });

    test("requires the key and locks out repeated failures", async () => {
      const loggedOut = await (await call("/k/a")).text();
      expect(loggedOut).toContain("<html");
      expect(loggedOut).not.toContain('id="admin-data"');
      expect(loggedOut).toContain('<div id="dashboard" hidden="">');
      expect((await call("/k/a/overview")).status).toBe(401);

      const ip = "203.0.113.150";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login("wrong-key", ip)).status).toBe(401);
      }
      expect((await login(adminKey, ip)).status).toBe(429);

      const ok = await login(adminKey, "198.51.100.77");
      expect(ok.status).toBe(200);
      const cookie = defined(ok.headers.get("set-cookie"), "a session cookie");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
      const session = cookie.split(";", 1)[0] ?? "";
      expect((await call("/k/a/overview", { headers: { cookie: session } })).status).toBe(200);
      // Logged in, the page comes open, with what the dashboard would ask for first.
      const page = await call("/k/a", { headers: { cookie: session } });
      expect(page.headers.get("cache-control")).toBe("no-store");
      const html = await page.text();
      expect(html).toMatch(/<form id="login-form"[^>]* hidden="">/);
      const embedded = /<script type="application\/json" id="admin-data">(.*?)<\/script>/s.exec(
        html,
      )?.[1];
      expect(JSON.parse(defined(embedded, "the embedded dashboard"))).toMatchObject({
        overview: { version: expect.any(String) },
        namespaces: { items: expect.any(Array), total: expect.any(Number) },
      });
      const forged = session.replace(/\.[^.]+$/, ".forged-signature");
      expect((await call("/k/a/overview", { headers: { cookie: forged } })).status).toBe(401);
    });

    test("logs in and out from the page's own forms, with no script", async () => {
      const form = (path: string, body: Record<string, string>, ip: string) =>
        call(path, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "cf-connecting-ip": ip,
          },
          body: new URLSearchParams(body).toString(),
        });
      // Logged out, the page is its form and loads no script.
      const page = await (await call("/k/a")).text();
      expect(page).toMatch(/<form id="login-form"[^>]*method="post" action="\/k\/a\/login"/);
      expect(page).not.toContain('type="module"');

      const wrong = await form("/k/a/login", { key: "wrong-key" }, "203.0.113.160");
      expect(wrong.status).toBe(401);
      expect(await wrong.text()).toContain(
        'class="status error" role="status" aria-live="polite">Wrong key.',
      );

      const right = await form("/k/a/login", { key: adminKey }, "203.0.113.161");
      expect(right.status).toBe(303);
      expect(right.headers.get("location")).toBe("/k/a");
      const session = defined(right.headers.get("set-cookie"), "a session").split(";", 1)[0] ?? "";
      expect(await (await call("/k/a", { headers: { cookie: session } })).text()).toContain(
        'id="admin-data"',
      );

      const out = await call("/k/a/logout", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: session },
      });
      expect(out.status).toBe(303);
      expect(out.headers.get("location")).toBe("/k/a");
      expect(out.headers.get("set-cookie")).toContain("kurobako_admin=;");
    });
  });
};
