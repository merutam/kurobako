import { expect, type Page, test } from "@playwright/test";

const production = "http://127.0.0.1:33110";

const shared = async (page: Page, text: string, headers: Record<string, string> = {}) => {
  const ns = `sitem${Date.now()}`;
  const sent = (await (
    await page.request.post(`${production}/${ns}/new`, {
      headers: { "Content-Type": "text/plain", ...headers },
      data: text,
    })
  ).json()) as { id: string };
  const link = (await (await page.request.post(`${production}/${ns}/${sent.id}/s`)).text()).trim();
  return { ns, path: new URL(link).pathname };
};

test("a shared text is copied from its page", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: production });
  const { path } = await shared(page, "line one\r\nline two");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${production}${path}`);
  await page.locator('[data-action="copy"]').click();
  await expect(page.locator("#status")).toContainText("Copied.");
  // The original bytes, not the HTML's normalized line endings.
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("line one\r\nline two");
  expect(errors).toEqual([]);
});

test("a shared item read once opens on its button, once", async ({ page }) => {
  const { ns, path } = await shared(page, "burnt", { Burn: "1" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${production}${path}`);
  await expect(page.locator("#items")).not.toContainText("burnt");
  await page.locator('[data-action="open-once"]').dblclick();
  await expect(page.locator("#items")).toContainText("burnt");
  await expect(page.locator("#status")).toContainText("Opened and deleted from the server.");
  expect(await (await page.request.get(`${production}/${ns}/ls`)).json()).toEqual([]);
  expect(errors).toEqual([]);
});

test("a shared image shows in its open row, fetched once", async ({ page }) => {
  const ns = `simg${Date.now()}`;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const sent = (await (
    await page.request.put(`${production}/${ns}/dot.png`, {
      headers: { "Content-Type": "image/png" },
      data: png,
    })
  ).json()) as { id: string };
  const link = (await (await page.request.post(`${production}/${ns}/${sent.id}/s`)).text()).trim();
  const path = new URL(link).pathname;
  const fetches: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(`${path}/c`)) fetches.push(request.url());
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${production}${path}`);
  await expect(page.locator("#items > li.open img")).toBeVisible();
  await expect(page.locator(".item-title")).toHaveText("dot.png");
  await page.waitForTimeout(500);
  expect(fetches).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a shared item reads without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const { path } = await shared(page, "plain words");
  await page.goto(`${production}${path}`);
  await expect(page.locator("#items > li.open pre")).toHaveText("plain words");
  await context.close();
});
