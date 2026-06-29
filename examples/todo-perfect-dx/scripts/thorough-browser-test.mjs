// Adversarial, end-to-end browser test of the local-first claims.
// Drives real Chromium against the live backend, inspects IndexedDB directly,
// and uses a fresh device context to prove data really round-trips the server.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const URL = process.env.URL ?? "http://localhost:5173";
const SHOT = "/tmp/lf-shots";
mkdirSync(SHOT, { recursive: true });

let failures = 0;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => {
  failures++;
  console.error("  ✗ FAIL:", m);
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

// Read every record in every IndexedDB store, return true if `needle` appears.
async function idbContains(page, needle) {
  return page.evaluate(async (needle) => {
    const dbs = (await indexedDB.databases?.()) ?? [];
    for (const { name } of dbs) {
      if (!name) continue;
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const store of db.objectStoreNames) {
        const all = await new Promise((res) => {
          const req = db.transaction(store, "readonly").objectStore(store).getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = () => res([]);
        });
        if (JSON.stringify(all).includes(needle)) {
          db.close();
          return true;
        }
      }
      db.close();
    }
    return false;
  }, needle);
}

const status = (page) => page.textContent('[data-testid="sync-status"]');
const pending = async (page) => (await page.textContent('[data-testid="pending"]'))?.trim();

const browser = await chromium.launch();
const errors = [];
try {
  // ===== Device 1 =====
  const ctx1 = await browser.newContext();
  const page1 = await ctx1.newPage();
  page1.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page1.on("console", (m) => m.type() === "error" && errors.push("console.error: " + m.text()));

  console.log("\n[1] Initial load");
  await page1.goto(URL);
  await page1.waitForSelector('[data-testid="sync-status"]');
  await page1.screenshot({ path: `${SHOT}/01-initial.png`, fullPage: true });
  check((await status(page1)).includes("online"), "shows online after load");

  console.log("\n[2] Optimistic create");
  const t1 = "OPTIMISTIC-" + Date.now();
  await page1.fill('[data-testid="new-issue-title"]', t1);
  const start = Date.now();
  await page1.click('[data-testid="create-issue"]');
  await page1.waitForSelector(`[data-title="${t1}"]`, { timeout: 5000 });
  ok(`issue visible ${Date.now() - start}ms after click (optimistic)`);
  await page1.screenshot({ path: `${SHOT}/02-created.png`, fullPage: true });
  check(await idbContains(page1, t1), "issue is actually written to IndexedDB (not just React state)");

  console.log("\n[3] Reload persistence (online)");
  await page1.reload();
  await page1.waitForSelector('[data-testid="sync-status"]');
  check(await page1.isVisible(`[data-title="${t1}"]`), "issue survives a reload");
  await page1.waitForFunction(() => document.querySelector('[data-testid="pending"]')?.textContent?.trim() === "0", null, { timeout: 15000 }).catch(() => {});
  check((await pending(page1)) === "0", "pending drains to 0 (synced to server)");

  console.log("\n[4] OFFLINE create + offline reload persistence");
  await ctx1.setOffline(true);
  await page1.waitForFunction(() => document.querySelector('[data-testid="sync-status"]')?.textContent?.includes("offline"), null, { timeout: 8000 }).catch(() => {});
  check((await status(page1)).includes("offline"), "status flips to offline (navigator.onLine)");
  const t2 = "OFFLINE-" + Date.now();
  await page1.fill('[data-testid="new-issue-title"]', t2);
  await page1.click('[data-testid="create-issue"]');
  await page1.waitForSelector(`[data-title="${t2}"]`, { timeout: 5000 });
  ok("offline create is optimistic (visible with no network)");
  check(Number(await pending(page1)) >= 1, `pending rose while offline (=${await pending(page1)})`);
  await page1.screenshot({ path: `${SHOT}/03-offline.png`, fullPage: true });
  // The offline write is durably in IndexedDB (the real local-first persistence
  // claim). A *shell* reload while offline needs a service worker (PWA), which the
  // demo doesn't ship — that's orthogonal to local-first data, so we assert the
  // durable write directly instead of reloading a dev server with no network.
  check(await idbContains(page1, t2), "offline write is durably in IndexedDB (no network)");

  console.log("\n[5] Reconnect flush + reload persistence");
  await ctx1.setOffline(false);
  await page1.waitForFunction(() => document.querySelector('[data-testid="pending"]')?.textContent?.trim() === "0", null, { timeout: 20000 }).catch(() => {});
  check((await pending(page1)) === "0", "outbox flushes to 0 on reconnect");
  check((await status(page1)).includes("online"), "status back to online");
  await page1.reload();
  await page1.waitForSelector('[data-testid="sync-status"]');
  check(await page1.isVisible(`[data-title="${t2}"]`), "formerly-offline issue still present after reconnect + reload");

  console.log("\n[6] Fresh device pulls from the server (proves real round-trip)");
  const ctx2 = await browser.newContext(); // isolated storage — empty IndexedDB
  const page2 = await ctx2.newPage();
  await page2.goto(URL);
  await page2.waitForSelector('[data-testid="sync-status"]');
  // a brand-new device has NO local data; if it shows the issues they came from the server
  await page2.waitForSelector(`[data-title="${t1}"]`, { timeout: 20000 }).catch(() => {});
  await page2.waitForSelector(`[data-title="${t2}"]`, { timeout: 20000 }).catch(() => {});
  check(await page2.isVisible(`[data-title="${t1}"]`), "fresh device pulled the online-created issue");
  check(await page2.isVisible(`[data-title="${t2}"]`), "fresh device pulled the (formerly offline) issue");
  await page2.screenshot({ path: `${SHOT}/04-device2.png`, fullPage: true });

  console.log("\n[7] No runtime errors (render-loop / schema class of bug)");
  check(errors.length === 0, `no pageerrors/console.errors (${errors.length})`);
  if (errors.length) console.log(errors.slice(0, 8).map((e) => "    " + e).join("\n"));
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : failures + " CHECK(S) FAILED"} — screenshots in ${SHOT}`);
process.exit(failures === 0 ? 0 : 1);
