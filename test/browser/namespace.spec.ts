import { expect, test } from "@playwright/test";

const production = "http://127.0.0.1:33110";
const pilot = "http://127.0.0.1:33111";

test("Solid hydrates under CSP and sends text without navigating", async ({ page, request }) => {
  const ns = `pilot${Date.now()}`;
  const source = "<script>window.injection = true</script>";
  await request.post(`${production}/${ns}/new`, {
    headers: { "Content-Type": "text/plain" },
    data: source,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`${pilot}/pilot/${ns}`);
  await expect(page.locator("li")).toHaveCount(1);
  await page.locator("textarea").fill("sent through Solid");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("li")).toHaveCount(2);
  expect(page.url()).toBe(`${pilot}/pilot/${ns}`);
  expect(await page.evaluate(() => "injection" in window)).toBe(false);
  expect(errors).toEqual([]);
});

test("production SSR respects CSP and live updates do not consume limited reads", async ({
  page,
  request,
}) => {
  const ns = `live${Date.now()}`;
  await request.post(`${production}/${ns}/new`, {
    headers: { "Content-Type": "text/plain", Reads: "2" },
    data: "hidden payload",
  });
  const violations: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { violations: string[] }).violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { violations: string[] }).violations.push(event.violatedDirective);
    });
  });
  await page.goto(`${production}/${ns}`);
  await expect(page.locator("#items > li")).toHaveCount(1);
  await expect(page.locator("#items")).not.toContainText("hidden payload");
  await expect(page.locator("#live-status")).toContainText("live");
  await request.post(`${production}/${ns}/new`, {
    headers: { "Content-Type": "text/plain" },
    data: "live arrival",
  });
  await expect(page.locator("#items > li")).toHaveCount(2);
  const listing = await (await request.get(`${production}/${ns}/ls`)).json();
  expect(
    listing.find((item: { readsLeft?: number }) => item.readsLeft !== undefined).readsLeft,
  ).toBe(2);
  violations.push(
    ...(await page.evaluate(() => (window as unknown as { violations: string[] }).violations)),
  );
  expect(violations).toEqual([]);
  const fill = await page.locator(".logo-front").evaluate((el) => getComputedStyle(el).fill);
  expect(fill).not.toBe("rgb(0, 0, 0)");
});
