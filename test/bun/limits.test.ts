// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Storage limits, who a limit counts, automated networks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { isAutomatedNetwork, networkKey } from "../../src/domain/networks";
import { clientKey } from "../../src/domain/visits";
import { startServer } from "../../src/infrastructure/bun/server";
import { config, fresh, memoryStore, useDefaultServer } from "./harness";

useDefaultServer();

describe("a storage limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "kurobako-storage-"));
  let limited: Awaited<ReturnType<typeof startServer>>;
  const at = (path: string, init?: RequestInit) =>
    fetch(`${limited.server.url.origin}${path}`, init);
  const file = (bytes: number) => ({ method: "PUT", body: new Uint8Array(bytes).fill(7) });

  beforeAll(async () => {
    limited = await startServer({
      config: { ...config, maxStorageBytes: 1_000, sendsPerMinute: 1000 },
      dataDir: dir,
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      logRequests: false,
    });
  });
  afterAll(async () => {
    await limited.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses what would go past it, across namespaces, until room is made", async () => {
    expect(await (await at("/.well-known/kurobako")).json()).toMatchObject({
      maxStorageBytes: 1_000,
    });
    const [one, two] = [fresh(), fresh()];
    expect((await at(`/${one}/a.bin`, file(600))).status).toBe(201);
    const refused = await at(`/${two}/b.bin`, file(600));
    expect(refused.status).toBe(507);
    expect(((await refused.json()) as { error: string }).error).toContain("full");
    // What still fits goes in.
    expect((await at(`/${two}/new`, { method: "POST", body: "small" })).status).toBe(201);
    // Deleting makes room again.
    await at(`/${one}/1`, { method: "DELETE" });
    expect((await at(`/${two}/b.bin`, file(600))).status).toBe(201);

    // A backup needs room for all of it.
    const backup = new Uint8Array(await (await at(`/${two}/zip`)).arrayBuffer());
    expect((await at(`/${fresh()}/import`, { method: "POST", body: backup })).status).toBe(507);
  });

  test("is off unless set", () => {
    expect(loadConfig({}).maxStorageBytes).toBeNull();
    expect(loadConfig({ MAX_STORAGE_BYTES: "0" }).maxStorageBytes).toBeNull();
    expect(loadConfig({ MAX_STORAGE_BYTES: "5000000000" }).maxStorageBytes).toBe(5_000_000_000);
  });
});

describe("who a limit counts", () => {
  test("an IPv6 address by its /64, however it is written", () => {
    expect(clientKey("203.0.113.5")).toBe("203.0.113.5");
    expect(clientKey("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(clientKey("2001:0DB8:ABCD:0012::9")).toBe("2001:db8:abcd:12::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    // IPv4 as dual-stack servers report it is IPv4.
    expect(clientKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(clientKey("unknown")).toBe("unknown");
    expect(clientKey("1::2::3")).toBe("1::2::3");
  });

  test("sends from one /64 share a budget; other networks have their own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kurobako-keys-"));
    const limited = await startServer({
      config: { ...config, sendsPerMinute: 2 },
      dataDir: dir,
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      clientIpHeader: "cf-connecting-ip",
      logRequests: false,
    });
    const send = (ip: string) =>
      fetch(`${limited.server.url.origin}/${fresh()}/new`, {
        method: "POST",
        headers: { "cf-connecting-ip": ip, "content-type": "text/plain" },
        body: ip,
      }).then((response) => response.status);
    try {
      // Three addresses of one network: the third send is over its budget.
      expect(await send("2001:db8:1:2::a")).toBe(201);
      expect(await send("2001:db8:1:2::b")).toBe(201);
      expect(await send("2001:db8:1:2:ffff::c")).toBe(429);
      // Another /64, and IPv4 addresses, are other clients.
      expect(await send("2001:db8:1:3::a")).toBe(201);
      expect(await send("203.0.113.7")).toBe(201);
      expect(await send("203.0.113.8")).toBe(201);
    } finally {
      await limited.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("automated networks", () => {
  test("are told by network, and counted by block", () => {
    expect(isAutomatedNetwork({ asn: 16509, country: "US" })).toBe(true);
    expect(isAutomatedNetwork({ asn: 7922, country: "US" })).toBe(false);
    expect(isAutomatedNetwork({ asn: null, country: "T1" })).toBe(true);
    expect(isAutomatedNetwork({ asn: null, country: null })).toBe(false);
    expect(networkKey("203.0.113.77")).toBe("203.0.113.0/24");
    expect(networkKey(clientKey("2001:db8:1:2:3::9"))).toBe("2001:db8:1::/48");
    expect(networkKey("unknown")).toBe("unknown");
  });

  const serve = (mode: "allow" | "block") =>
    startServer({
      config: { ...config, automatedNetworks: mode, sendsPerMinute: 2 },
      dataDir: mkdtempSync(join(tmpdir(), "kurobako-networks-")),
      blobs: memoryStore().store,
      port: 0,
      hostname: "127.0.0.1",
      clientIpHeader: "cf-connecting-ip",
      logRequests: false,
    });
  const sendFrom = (origin: string, headers: Record<string, string>) =>
    fetch(`${origin}/${fresh()}/new`, {
      method: "POST",
      headers: { ...headers, "content-type": "text/plain" },
      body: "hello",
    });

  test("block: no sends from them, reading as usual", async () => {
    const running = await serve("block");
    const origin = running.server.url.origin;
    try {
      const refused = await sendFrom(origin, {
        "cf-connecting-ip": "203.0.113.5",
        "cf-asn": "14061",
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toContain("VPNs");
      // Tor too, by Cloudflare's country for it.
      const tor = { "cf-connecting-ip": "203.0.113.6", "cf-ipcountry": "T1" };
      expect((await sendFrom(origin, tor)).status).toBe(403);
      // A home sends; the blocked network still reads.
      const ns = fresh();
      await fetch(`${origin}/${ns}/new`, {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.9", "content-type": "text/plain" },
        body: "readable",
      });
      const read = await fetch(`${origin}/${ns}/1`, { headers: tor });
      expect(await read.text()).toBe("readable");
    } finally {
      await running.stop();
    }
  });

  test("allow: counted like anyone, address by address", async () => {
    const running = await serve("allow");
    const origin = running.server.url.origin;
    try {
      for (let last = 1; last <= 4; last += 1) {
        const sent = await sendFrom(origin, {
          "cf-connecting-ip": `203.0.113.${last}`,
          "cf-asn": "16509",
        });
        expect(sent.status).toBe(201);
      }
    } finally {
      await running.stop();
    }
  });
});
