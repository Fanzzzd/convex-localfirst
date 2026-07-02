import { test, expect } from "@playwright/test";

// Presence: heartbeats into the mounted component, live membership-checked reads.
// Fresh workspace per test so counts start from zero.
const newWs = () => `presence-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test("two devices in a workspace see each other's presence live", async ({ browser }) => {
  const ws = newWs();

  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto(`/?ws=${ws}`);
  await expect(pageA.getByTestId("presence-count")).toHaveText("1", { timeout: 15_000 });

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(`/?ws=${ws}`);

  // Both devices converge on 2 — B's heartbeat is a table write, so A's
  // subscribed presence query re-runs without polling.
  await expect(pageB.getByTestId("presence-count")).toHaveText("2", { timeout: 15_000 });
  await expect(pageA.getByTestId("presence-count")).toHaveText("2", { timeout: 15_000 });

  // Leave: beforeunload sends a best-effort leaving beat; the TTL is the backstop.
  await pageB.close({ runBeforeUnload: true });
  await ctxB.close();
  await expect(pageA.getByTestId("presence-count")).toHaveText("1", { timeout: 45_000 });

  await ctxA.close();
});
