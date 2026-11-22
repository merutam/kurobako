import { expect, test } from "bun:test";
import { startPilot } from "./server";

test("an unavailable explicit backend returns actionable 502 responses", async () => {
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const upstream = backend.url.origin;
  await backend.stop(true);
  const pilot = await startPilot({ upstream, port: 0 });
  try {
    const response = await fetch(`${pilot.url}pilot/example`);
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("unset PILOT_UPSTREAM");
    expect((await fetch(`${pilot.url}api/example/ls`)).status).toBe(502);
    expect((await fetch(pilot.url, { redirect: "manual" })).headers.get("location")).toBe(
      "/pilot/example",
    );
  } finally {
    await pilot.stop(true);
  }
});

test("an occupied pilot port suggests a different port", async () => {
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  try {
    await expect(
      startPilot({ upstream: "http://127.0.0.1:3000", port: holder.port }),
    ).rejects.toThrow("PILOT_PORT=");
  } finally {
    await holder.stop(true);
  }
});

test("the launcher starts a working temporary backend without external services", async () => {
  const child = Bun.spawn(["bun", "--no-env-file", "ops/pilot.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, PILOT_PORT: "0", PILOT_UPSTREAM: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), 15_000);
  try {
    const reader = child.stdout.getReader();
    let output = "";
    let url = "";
    while (!url) {
      const { value, done } = await reader.read();
      if (done)
        throw new Error(
          `Pilot exited before startup: ${output} ${await new Response(child.stderr).text()}`,
        );
      output += new TextDecoder().decode(value);
      url = /Solid pilot: (http:\/\/\S+)/.exec(output)?.[1] ?? "";
    }
    expect(output).toContain("Temporary demo backend");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Namespace pilot");
    const api = new URL("/api/example", url);
    expect(
      (
        await fetch(`${api}/new`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "local demo",
        })
      ).status,
    ).toBe(201);
    expect(await (await fetch(`${api}/1`)).text()).toBe("local demo");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }
  expect(child.exitCode).toBe(0);
});
