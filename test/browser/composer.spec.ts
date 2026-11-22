import { expect, type Page, test } from "@playwright/test";

const production = "http://127.0.0.1:33110";

const items = (page: Page) => page.locator("#items > li");
const listing = async (page: Page, ns: string) =>
  (await (await page.request.get(`${production}/${ns}/ls`)).json()) as {
    id: string;
    kind: string;
    name?: string;
    filename?: string;
    mime?: string;
    text?: string;
  }[];

const open = async (page: Page, ns: string) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${production}/${ns}`);
  await expect(page.locator("#send-button")).toBeEnabled();
  return errors;
};

test("a text is sent, named by its start", async ({ page }) => {
  const ns = `ctext${Date.now()}`;
  const errors = await open(page, ns);
  await page.locator("#text").fill("# Shopping list\n\n- eggs");
  await page.locator("#send-button").click();
  await expect(items(page)).toHaveCount(1);
  await expect(page.locator("#status")).toContainText("Sent.");
  const [item] = await listing(page, ns);
  expect(item?.kind).toBe("text");
  expect(item?.name).toBe("Shopping list eggs.md");
  // The composer starts over.
  await expect(page.locator("#text")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("files are listed, removable and sent one item each", async ({ page }) => {
  const ns = `cfiles${Date.now()}`;
  const errors = await open(page, ns);
  await page.locator("#files-tab").click();
  await page.locator("#file").setInputFiles([
    { name: "my notes.txt", mimeType: "text/plain", buffer: Buffer.from("one") },
    { name: "two.bin", mimeType: "application/octet-stream", buffer: Buffer.from("two") },
    { name: "three.bin", mimeType: "application/octet-stream", buffer: Buffer.from("three") },
  ]);
  await expect(page.locator("#files-tab")).toHaveText("files (3)");
  // Renamed without spaces, so a text can refer to it as it is.
  await expect(page.locator("#file-list")).toContainText("my-notes.txt");
  await page.getByRole("button", { name: "Remove three.bin" }).click();
  await expect(page.locator("#files-tab")).toHaveText("files (2)");
  await expect(page.locator("#send-summary")).toHaveText("2 files, one item each.");
  await page.locator("#send-button").click();
  await expect(items(page)).toHaveCount(2);
  const names = (await listing(page, ns)).map((item) => item.filename);
  expect(names).toEqual(["my-notes.txt", "two.bin"]);
  await expect(page.locator("#files-tab")).toHaveText("files");
  expect(errors).toEqual([]);
});

test("two texts and a file go as one bundle", async ({ page }) => {
  const ns = `cbundle${Date.now()}`;
  const errors = await open(page, ns);
  await page.locator("#text").fill("first text");
  await page.locator("#add-tab").click();
  await page.locator("#text").fill("second text");
  await page.locator("#files-tab").click();
  await page.locator("#file").setInputFiles({
    name: "a.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("x"),
  });
  await expect(page.locator("#send-summary")).toHaveText("Bundle: 2 texts, 1 file.");
  await page.locator("#send-button").click();
  await expect(items(page)).toHaveCount(1);
  const [item] = await listing(page, ns);
  expect(item?.mime).toBe("application/vnd.kurobako.bundle+tar");
  expect(errors).toEqual([]);
});

test("a text is edited in the composer and saved", async ({ page, request }) => {
  const ns = `cedit${Date.now()}`;
  await request.post(`${production}/${ns}/new`, {
    headers: { "Content-Type": "text/plain" },
    data: "before",
  });
  const errors = await open(page, ns);
  await page.locator('[data-action="edit"]').click();
  await expect(page.locator("#send-title")).toHaveText("Edit");
  await expect(page.locator("#text")).toHaveValue("before");
  await expect(page.locator("#add-tab")).toBeHidden();
  await page.locator("#text").fill("after");
  await page.locator("#send-button").click();
  await expect(page.locator("#status")).toContainText("Saved.");
  await expect(page.locator("#send-title")).toHaveText("Send");
  const [item] = await listing(page, ns);
  expect(item?.text).toBe("after");
  expect(errors).toEqual([]);
});

test("a Markdown text previews, with a pasted file referenced", async ({ page }) => {
  const ns = `cpreview${Date.now()}`;
  const errors = await open(page, ns);
  await page.locator("#text").fill("# Title\n\n");
  await page.locator("#text").evaluate((textarea: HTMLTextAreaElement) => {
    const data = new DataTransfer();
    data.items.add(new File(["png"], "image.png", { type: "image/png" }));
    textarea.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator("#text")).toHaveValue(/!\[\]\(assets\/paste-\d{8}-\d{6}\.png\)/);
  await expect(page.locator("#files-tab")).toHaveText("files (1)");
  await page.locator("#preview-toggle").click();
  await expect(page.locator("#markdown-preview h1")).toHaveText("Title");
  expect(errors).toEqual([]);
});
