import { expect, test } from "bun:test";

const renderPath = "./.dist/server/render.js";
const { render } = (await import(renderPath)) as typeof import("./entry-server");

test("SSR has initial rows, escapes payloads, and uses a CSP nonce", () => {
  const html = render(
    {
      namespace: "example",
      api: "/api/example",
      items: [{ id: "one", kind: "text", text: "</script><script>bad()</script>", size: 10 }],
    },
    "test-nonce",
  );
  expect(html).toContain("data-hk");
  expect(html).toContain('nonce="test-nonce"');
  expect(html).not.toContain("<script>bad()");
  expect(html).toContain("/api/example/one/d");
  const data = html.match(/id="snapshot">(.*?)<\/script>/s)?.[1];
  expect(JSON.parse(data ?? "null").items[0].text).toBe("</script><script>bad()</script>");
});

test("limited items are never prefetched or exposed by the pilot", () => {
  const html = render(
    {
      namespace: "example",
      api: "/api/example",
      items: [{ id: "limited", kind: "text", text: "secret", size: 6, readsLeft: 1 }],
    },
    "test-nonce",
  );
  expect(html).toContain("Hidden until opened");
  expect(html).toContain("uses a read");
  // Rows do not render text bodies. Production summaries omit them as well.
  expect(html).not.toContain("<img");
  expect(html).not.toContain("secret");
});
