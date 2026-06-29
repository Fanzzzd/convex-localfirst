import { test, expect, type Page } from "@playwright/test";

// End-to-end browser tests for the Linear-lite board against the LIVE backend.
// These exercise the parts unit tests can't: real React re-renders, IndexedDB,
// the live WebSocket transport, and offline/online transitions in Chromium.

const card = (title: string) => `[data-testid=issue-card][data-title="${title}"]`;
const uniq = (p: string) => `${p} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Each test-run gets its own fresh workspace (?ws=) so a cold device only ever
// pulls this run's handful of issues — a shared workspace accumulates every
// run's data and a fresh device's first pull grows unbounded across runs.
const WS = `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Fail the test if the page logs any console error or throws. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function load(page: Page) {
  await page.goto(`/?ws=${WS}`);
  await expect(page.getByRole("heading", { name: /Linear-lite/ })).toBeVisible();
  // membership join (a plain Convex mutation via the fallback path) settles.
  await expect(page.getByTestId("member-count")).toHaveText("1");
}

test("renders, creates an issue optimistically, and syncs it to the server", async ({ page }) => {
  const errors = trackErrors(page);
  await load(page);

  const title = uniq("Ship");
  await page.getByTestId("new-issue-title").fill(title);
  await page.getByTestId("create-issue").click();

  // Optimistic: the card shows up in Backlog before any server round-trip.
  await expect(page.locator(card(title))).toBeVisible();
  await expect(page.locator(card(title))).toHaveAttribute("data-status", "backlog");

  // Then it syncs: pending count returns to 0.
  await expect(page.getByTestId("pending")).toHaveText("0");
  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("moves an issue across columns (patch is optimistic + persists)", async ({ page }) => {
  await load(page);
  const title = uniq("Move");
  await page.getByTestId("new-issue-title").fill(title);
  await page.getByTestId("create-issue").click();
  await expect(page.locator(card(title))).toBeVisible();

  // backlog -> in_progress -> done
  await page.locator(card(title)).getByTestId("move-right").click();
  await expect(page.locator(card(title))).toHaveAttribute("data-status", "in_progress");
  await page.locator(card(title)).getByTestId("move-right").click();
  await expect(page.locator(card(title))).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("pending")).toHaveText("0");
});

test("an issue survives a page reload (IndexedDB persistence)", async ({ page }) => {
  await load(page);
  const title = uniq("Persist");
  await page.getByTestId("new-issue-title").fill(title);
  await page.getByTestId("create-issue").click();
  await expect(page.locator(card(title))).toBeVisible();
  await expect(page.getByTestId("pending")).toHaveText("0");

  await page.reload();
  await expect(page.getByRole("heading", { name: /Linear-lite/ })).toBeVisible();
  await expect(page.locator(card(title))).toBeVisible();
});

test("offline create is optimistic, marks offline, and flushes on reconnect", async ({ page, context }) => {
  await load(page);

  await context.setOffline(true);
  await expect(page.getByTestId("sync-status")).toContainText("offline");

  const title = uniq("Offline");
  await page.getByTestId("new-issue-title").fill(title);
  await page.getByTestId("create-issue").click();
  await expect(page.locator(card(title))).toBeVisible(); // optimistic while offline
  await expect(page.getByTestId("pending")).not.toHaveText("0"); // still owed

  await context.setOffline(false);
  await expect(page.getByTestId("sync-status")).toContainText("online");
  // The provider flushes the outbox on reconnect → pending returns to 0.
  await expect(page.getByTestId("pending")).toHaveText("0");
});

test("an idle client sees another client's create in real time (reactive push, no poll/reload)", async ({ browser }) => {
  // B loads and goes idle FIRST. Then A creates. The board query carries no
  // pollMs, so the ONLY way B learns of the new issue without acting/reloading is
  // the reactive transport subscription (server push). This fails on the old
  // mount/local-change-only pull path.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await load(pageA);
  await load(pageB); // B is now mounted, settled, and idle — no further interaction

  const title = uniq("Realtime");
  await pageA.getByTestId("new-issue-title").fill(title);
  await pageA.getByTestId("create-issue").click();
  await expect(pageA.getByTestId("pending")).toHaveText("0"); // durably on the server

  // B never acts: the card must arrive via the live subscription alone.
  await expect(pageB.locator(card(title))).toBeVisible({ timeout: 15000 });

  await ctxA.close();
  await ctxB.close();
});

test("reactive sync survives a disconnect: an offline idle client catches up on reconnect", async ({ browser }) => {
  // Maturity check for the live subscription: B is idle and goes OFFLINE, A creates
  // while B is disconnected, then B reconnects. B must catch up via the watch
  // re-firing on reconnect — no reload, no manual refetch.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await load(pageA);
  await load(pageB);

  await ctxB.setOffline(true);
  await expect(pageB.getByTestId("sync-status")).toContainText("offline");

  const title = uniq("Reconnect");
  await pageA.getByTestId("new-issue-title").fill(title);
  await pageA.getByTestId("create-issue").click();
  await expect(pageA.getByTestId("pending")).toHaveText("0"); // on the server while B is offline

  await ctxB.setOffline(false);
  await expect(pageB.getByTestId("sync-status")).toContainText("online");
  // B never acts: the live subscription re-establishes and delivers the missed change.
  await expect(pageB.locator(card(title))).toBeVisible({ timeout: 20000 });

  await ctxA.close();
  await ctxB.close();
});

test("a second client (fresh device) pulls an issue created by the first", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await load(pageA);
  const title = uniq("Shared");
  await pageA.getByTestId("new-issue-title").fill(title);
  await pageA.getByTestId("create-issue").click();
  await expect(pageA.getByTestId("pending")).toHaveText("0"); // durably on the server

  // Fresh browser context = separate IndexedDB = a second device.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await load(pageB); // mount → pulls the workspace scope
  await expect(pageB.locator(card(title))).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});
