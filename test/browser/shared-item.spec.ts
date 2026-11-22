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
  await page.getByRole("button", { name: "Copy" }).click();
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
  await expect(page.locator("#item-body")).not.toContainText("burnt");
  await page.getByRole("button", { name: "Open once" }).dblclick();
  await expect(page.locator("#item-body")).toContainText("burnt");
  await expect(page.locator("#status")).toContainText("Opened and deleted from the server.");
  expect(await (await page.request.get(`${production}/${ns}/ls`)).json()).toEqual([]);
  expect(errors).toEqual([]);
});
