// Seeds a few realistic issues into the (fresh) demo workspace and screenshots
// the board, so we can judge the actual UX.
import { chromium } from "@playwright/test";

const URL = process.env.URL ?? "http://localhost:5173";
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto(URL);
await page.waitForSelector('[data-testid="sync-status"]');

const seed = [
  { title: "Design onboarding flow", priority: "Urgent", move: 0 },
  { title: "Add dark-mode toggle", priority: "Low", move: 0 },
  { title: "Investigate flaky sync test", priority: "High", move: 0 },
  { title: "Fix auth redirect loop", priority: "Urgent", move: 1 },
  { title: "Optimistic UI for comments", priority: "Medium", move: 1 },
  { title: "Ship local-first docs", priority: "High", move: 2 },
];

const cardSel = (t) => `[data-testid=issue-card][data-title="${t}"]`;

for (const it of seed) {
  await page.getByTestId("new-issue-priority").click();
  await page.getByRole("option", { name: it.priority, exact: true }).click();
  await page.getByTestId("new-issue-title").fill(it.title);
  await page.getByTestId("create-issue").click();
  await page.waitForSelector(cardSel(it.title));
  for (let i = 0; i < it.move; i++) {
    await page.locator(cardSel(it.title)).getByTestId("move-right").click();
    await page.waitForTimeout(120);
  }
}

await page
  .waitForFunction(
    () => document.querySelector("[data-testid=pending]")?.textContent?.trim() === "0",
    null,
    { timeout: 15000 },
  )
  .catch(() => {});
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/lf-shots/board-shadcn.png", fullPage: true });
await browser.close();
console.log("screenshot saved to /tmp/lf-shots/board-shadcn.png");
