import { test, expect, type Page } from "@playwright/test";

// E2e for the Notion-style docs: BlockNote content synced as a Yjs CRDT over our
// insert-only doc_updates rows. Proves persistence + true cross-device merge
// against the LIVE backend.

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// Fresh workspace PER TEST so a second device sees only this test's page (no
// auto-select ambiguity) and only pulls this test's handful of updates.
const newWs = () => `docs-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function openDocs(page: Page, ws: string) {
  await page.goto(`/?ws=${ws}`);
  await expect(page.getByTestId("member-count")).toHaveText("1");
  await page.getByTestId("tab-docs").click();
}

const editorBody = (page: Page) =>
  page.locator('[data-testid=doc-editor] [contenteditable="true"]').first();

test("create a page, edit it, and it persists across reload", async ({ page }) => {
  const errors = trackErrors(page);
  await openDocs(page, newWs());

  await page.getByTestId("new-page").click();
  await expect(page.getByTestId("doc-editor")).toBeVisible();

  const body = uniq("note");
  await editorBody(page).click();
  await page.keyboard.type(body, { delay: 5 });
  await expect(page.getByTestId("doc-editor")).toContainText(body);

  // The page content is a Yjs doc synced as doc_updates rows -> pending drains.
  await expect(page.getByTestId("pending")).toHaveText("0");

  // Reload: a fresh load re-applies the doc_updates rows into the Y.Doc.
  await page.reload();
  await page.getByTestId("tab-docs").click();
  await page.getByTestId("doc-item").first().click();
  await expect(page.getByTestId("doc-editor")).toContainText(body);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("a second device sees edits to the same page (Yjs converges)", async ({ browser }) => {
  const ws = newWs();
  const title = uniq("Shared Doc");
  const body = uniq("collab-body");

  // Device A: create + title + body, then wait for it to sync.
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  const errA = trackErrors(pageA);
  await openDocs(pageA, ws);
  await pageA.getByTestId("new-page").click();
  await expect(pageA.getByTestId("doc-editor")).toBeVisible();
  await pageA.getByTestId("doc-title").fill(title);
  await editorBody(pageA).click();
  await pageA.keyboard.type(body, { delay: 5 });
  await expect(pageA.getByTestId("pending")).toHaveText("0");

  // Device B: fresh device, same workspace, opens the same page -> sees A's text.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const errB = trackErrors(pageB);
  await openDocs(pageB, ws);
  await pageB.locator(`[data-testid=doc-item][data-title="${title}"]`).click();
  await expect(pageB.getByTestId("doc-editor")).toContainText(body, { timeout: 15000 });

  // And the reverse: B edits, A converges (live, both online).
  const more = uniq("from-B");
  await editorBody(pageB).click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.type(" " + more, { delay: 5 });
  await expect(pageA.getByTestId("doc-editor")).toContainText(more, { timeout: 15000 });

  expect(errA, `A console errors:\n${errA.join("\n")}`).toEqual([]);
  expect(errB, `B console errors:\n${errB.join("\n")}`).toEqual([]);
  await ctxA.close();
  await ctxB.close();
});
