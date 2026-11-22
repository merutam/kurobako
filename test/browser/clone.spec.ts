import { expect, type Page, test } from "@playwright/test";

const production = "http://127.0.0.1:33110";

/** A view of a named text and a file, opened on its page. */
const openView = async (page: Page): Promise<{ ns: string; viewUrl: string }> => {
  const ns = `csrc${Date.now()}`;
  await page.request.post(`${production}/${ns}/new`, {
    headers: { "Content-Type": "text/plain", "X-Text-Name": "notes.md" },
    data: "# Notes",
  });
  await page.request.put(`${production}/${ns}/data.bin`, {
    headers: { "Content-Type": "application/octet-stream" },
    data: Buffer.from("binary"),
  });
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
  await page.goto(`${production}${created.url}`);
  await expect(page.locator("#items > li")).toHaveCount(2);
  return { ns, viewUrl: created.url };
};

test("a view clones into a new plain namespace", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openView(page);
  const destination = `cdst${Date.now()}`;
  await page.locator("#clone-name").fill(destination);
  await page.locator('#clone-form button[type="submit"]').click();
  await expect(page.locator("#view-status")).toContainText("Clone complete: 2 copied, 0 skipped");
  const listed = await (await page.request.get(`${production}/${destination}/ls`)).json();
  expect(
    listed.map((item: { name?: string; filename?: string }) => item.name ?? item.filename),
  ).toEqual(["data.bin", "notes.md"]);
  expect(errors).toEqual([]);
});

test("a view clones into a new encrypted namespace", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openView(page);
  const secret = `correct horse battery clone ${Date.now()}`;
  await page.locator("#clone-encrypted").check();
  await page.locator("#clone-name").fill(secret);
  await page.locator('#clone-form button[type="submit"]').click();
  await expect(page.locator("#view-status")).toContainText("Clone complete: 2 copied, 0 skipped", {
    timeout: 15_000,
  });
  await page.goto(`${production}/e#${encodeURIComponent(secret)}`);
  await expect(page.locator(".item-title")).toHaveText(["data.bin", "notes.md"], {
    timeout: 15_000,
  });
  expect(errors).toEqual([]);
});

test("a clone that fails part way says so and leaves what it copied", async ({ page }) => {
  await openView(page);
  const destination = `cpart${Date.now()}`;
  let sends = 0;
  // The second item's send fails, as a dropped connection would.
  await page.route(`**/${destination}/new`, (route) =>
    ++sends === 2 ? route.abort("failed") : route.continue(),
  );
  await page.locator("#clone-name").fill(destination);
  await page.locator('#clone-form button[type="submit"]').click();
  await expect(page.locator("#view-status")).toContainText("Clone incomplete: 1 copied, 0 skipped");
  const listed = await (await page.request.get(`${production}/${destination}/ls`)).json();
  expect(listed).toHaveLength(1);
});

test("an item changed while it is copied is skipped, not copied half old", async ({ page }) => {
  const { ns, viewUrl } = await openView(page);
  const view = await (await page.request.get(`${production}${viewUrl}.json`)).json();
  const textEntry = view.entries.find(
    (entry: { item: { kind: string } }) => entry.item.kind === "text",
  );
  const [source] = (await (await page.request.get(`${production}/${ns}/ls`)).json()).filter(
    (item: { kind: string }) => item.kind === "text",
  );
  // The owner edits the text while the clone is reading it.
  await page.route(`**${textEntry.url}/c`, async (route) => {
    await page.request.post(`${production}/${ns}/${source.id}/e`, {
      headers: { "Content-Type": "text/plain", "If-Match": JSON.stringify(source.createdAt) },
      data: "# Notes, edited",
    });
    await route.continue();
  });
  const destination = `cchg${Date.now()}`;
  await page.locator("#clone-name").fill(destination);
  await page.locator('#clone-form button[type="submit"]').click();
  await expect(page.locator("#view-status")).toContainText("Clone complete: 1 copied, 1 skipped");
  const listed = await (await page.request.get(`${production}/${destination}/ls`)).json();
  expect(listed.map((item: { filename?: string }) => item.filename)).toEqual(["data.bin"]);
});
