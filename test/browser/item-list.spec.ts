import { expect, type Page, test } from "@playwright/test";

const production = "http://127.0.0.1:33110";

const send = async (page: Page, ns: string, text: string, headers: Record<string, string> = {}) =>
  (
    await page.request.post(`${production}/${ns}/new`, {
      headers: { "Content-Type": "text/plain", ...headers },
      data: text,
    })
  ).json() as Promise<{ id: string }>;

const open = async (page: Page, ns: string, count: number) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${production}/${ns}`);
  await expect(page.locator("#items > li")).toHaveCount(count);
  await expect(page.locator("#live-status")).toContainText("live");
  return errors;
};

test("an item is renamed in place", async ({ page }) => {
  const ns = `lrename${Date.now()}`;
  await send(page, ns, "some words");
  const errors = await open(page, ns, 1);
  await page.locator(".item-title").dblclick();
  const input = page.locator(".rename-input");
  await expect(input).toBeFocused();
  await input.fill("renamed.md");
  await input.press("Enter");
  await expect(page.locator(".item-title")).toHaveText("renamed.md");
  const [item] = await (await page.request.get(`${production}/${ns}/ls`)).json();
  expect(item.name).toBe("renamed.md");
  expect(errors).toEqual([]);
});

test("open: one closes the others, all opens every row and is remembered", async ({ page }) => {
  const ns = `lexpand${Date.now()}`;
  await send(page, ns, "first");
  await send(page, ns, "second");
  const errors = await open(page, ns, 2);
  const toggles = page.locator("button.item-toggle");
  await toggles.nth(0).click();
  await expect(page.locator("#items > li.open")).toHaveCount(1);
  await toggles.nth(1).click();
  await expect(page.locator("#items > li.open")).toHaveCount(1);
  await expect(page.locator("#items > li").nth(1)).toHaveClass(/open/);
  await page.locator('#expand-mode [data-choice="all"]').click();
  await expect(page.locator("#items > li.open")).toHaveCount(2);
  await page.reload();
  await expect(page.locator("#items > li.open")).toHaveCount(2);
  await page.locator('#expand-mode [data-choice="one"]').click();
  await expect(page.locator("#items > li.open")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an item read once stays shown until dismissed", async ({ page }) => {
  const ns = `lonce${Date.now()}`;
  await send(page, ns, "only once", { Burn: "1" });
  const errors = await open(page, ns, 1);
  await page.locator('[data-action="open-once"]').click();
  await expect(page.locator("#items")).toContainText("only once");
  await expect(page.locator("#status")).toContainText("Opened and deleted from the server.");
  expect(await (await page.request.get(`${production}/${ns}/ls`)).json()).toEqual([]);
  await page.locator('[data-action="dismiss"]').click();
  await expect(page.locator("#items > li")).toHaveCount(0);
  await expect(page.locator("#empty")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a shared view lists its items read-only", async ({ page }) => {
  const ns = `lview${Date.now()}`;
  await send(page, ns, "in the view");
  const { items } = await (await page.request.get(`${production}/${ns}/views`)).json();
  const created = await (
    await page.request.post(`${production}/${ns}/views`, {
      headers: { "Content-Type": "application/json" },
      data: {
        viewId: "abcdefghijklmnopqrstuA",
        previousToken: null,
        entries: items.map((item: { id: string }) => ({ id: item.id })),
      },
    })
  ).json();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${production}${created.url}`);
  await expect(page.locator("#items > li")).toHaveCount(1);
  await page.locator("button.item-toggle").click();
  await expect(page.locator("#items")).toContainText("in the view");
  await expect(page.locator('[data-action="delete"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
