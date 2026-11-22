// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import type { AccessLogEntry } from "../../src/domain/visits";
import type { Harness } from "./index";
import { LIMIT_TEST_MS, type Tools } from "./tools";

export const limitsTests = (harness: Harness, tools: Tools) => {
  const { describe, test, expect, call, config, limitWindow } = harness;
  const { json, sendText, fresh } = tools;
  describe("send limit", () => {
    test(
      "allows the configured sends a minute per address, then answers 429",
      async () => {
        await limitWindow();
        const ns = fresh("limit");
        const ip = { "cf-connecting-ip": "192.0.2.199" };
        const statuses: number[] = [];
        for (let index = 0; index < config.sendsPerMinute; index += 1) {
          statuses.push((await sendText(ns, `item ${index}`, ip)).status);
        }
        expect(statuses.every((status) => status === 201)).toBe(true);
        const blocked = await sendText(ns, "one too many", ip);
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("retry-after")).toBe("60");
        // Another address is not affected.
        expect(
          (await sendText(ns, "someone else", { "cf-connecting-ip": "192.0.2.200" })).status,
        ).toBe(201);
      },
      LIMIT_TEST_MS,
    );
  });

  describe("automated networks", () => {
    test(
      "a cloud's addresses share their block's budget; a home in it keeps its own",
      async () => {
        await limitWindow();
        const ns = fresh("cloud");
        // Addresses of one /24 on Amazon's network (ASN 16509), as a script spread over them.
        const cloud = (last: number) => ({
          "cf-connecting-ip": `100.64.5.${last}`,
          "cf-asn": "16509",
        });
        const statuses: number[] = [];
        // Spread over the block's addresses, apart from the home one below.
        for (let index = 0; index < config.sendsPerMinute; index += 1) {
          statuses.push((await sendText(ns, `cloud ${index}`, cloud((index % 200) + 1))).status);
        }
        expect(statuses.every((status) => status === 201)).toBe(true);
        expect((await sendText(ns, "one more", cloud(200))).status).toBe(429);
        // Another provider block, and a home address in the same /24, are counted apart.
        expect(
          (
            await sendText(ns, "next block", {
              "cf-connecting-ip": "100.64.6.1",
              "cf-asn": "16509",
            })
          ).status,
        ).toBe(201);
        expect((await sendText(ns, "a home", { "cf-connecting-ip": "100.64.5.250" })).status).toBe(
          201,
        );
      },
      LIMIT_TEST_MS,
    );
  });

  describe("miss limit", () => {
    test(
      "past the configured requests for things that are not there, the client reads nothing",
      async () => {
        await limitWindow();
        const ns = fresh("present");
        await sendText(ns, "here all along");
        const scanner = { "cf-connecting-ip": "192.0.2.210" };
        // Names, items and share links that do not exist: each one a miss.
        for (let index = 0; index <= config.missesPerMinute; index += 1) {
          const path =
            index % 3 === 0
              ? `/${fresh("absent")}/ls`
              : index % 3 === 1
                ? `/${ns}/zzzzzz`
                : "/i/AAAAAAAAAAAAAA";
          expect((await call(path, { headers: scanner })).status).not.toBe(429);
        }
        // Even what exists answers 429, or a script would learn which names exist.
        const blocked = await call(`/${ns}/1`, { headers: scanner });
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("retry-after")).toBe("60");
        // Another client reads as usual, and pages outside namespaces stay open.
        const other = await call(`/${ns}/1`, { headers: { "cf-connecting-ip": "192.0.2.211" } });
        expect(await other.text()).toBe("here all along");
        expect((await call("/.well-known/kurobako", { headers: scanner })).status).toBe(200);
      },
      LIMIT_TEST_MS,
    );
  });

  describe("access logs", () => {
    test("logs each namespace separately, with location", async () => {
      const [alpha, beta] = [fresh(), fresh()];
      await sendText(alpha, "first");
      await call(`/${alpha}/ls`, {
        headers: {
          "cf-connecting-ip": "203.0.113.42",
          "cf-ipcountry": "BR",
          "cf-region": "Minas Gerais",
          "cf-ipcity": "Itabirito",
          "user-agent": "Alpha Browser",
        },
      });
      await sendText(beta, "beta", { "cf-connecting-ip": "198.51.100.20" });

      const alphaLog = await (await call(`/${alpha}/log`)).text();
      expect(alphaLog).toContain("203.0.113.42");
      expect(alphaLog).toContain("Itabirito, Minas Gerais, BR");
      expect(alphaLog).not.toContain("198.51.100.20");
      expect(alphaLog).toContain(`href="/${alpha}">Back to namespace</a>`);
      expect(alphaLog).toContain(`href="/${alpha}/log.json">As JSON</a>`);
      expect(alphaLog).toMatch(/type="module" src="\/k\/assets\/log-[0-9a-z]+\.js"/);
      expect(alphaLog).not.toContain("<main data-loading>");
      expect(alphaLog).not.toContain('id="log-back-row" hidden');
      expect((await call("/log.json")).status).toBe(404);
    });

    test("does not create namespaces for probes", async () => {
      const ns = fresh();
      await call(`/${ns}/ls`, { headers: { "cf-connecting-ip": "192.0.2.9" } });
      expect(await json<AccessLogEntry[]>(`/${ns}/log.json`)).toEqual([]);
    });
  });
};
