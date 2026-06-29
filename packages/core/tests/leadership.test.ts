import { afterEach, describe, expect, it, vi } from "vitest";
import { TabLeadership, type LockManagerLike } from "../src/internal";

const tabs: TabLeadership[] = [];

afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.stop();
  }
});

/** A minimal single-holder Web Locks manager: one exclusive holder per name; queued
 *  requests run (FIFO) when the holder releases, mirroring navigator.locks. */
function makeFakeLockManager(): LockManagerLike {
  type Entry = { cb: () => Promise<unknown>; resolve: () => void; reject: (e: unknown) => void };
  const queues = new Map<string, Entry[]>();
  const active = new Map<string, boolean>();
  const pump = (name: string) => {
    if (active.get(name)) return;
    const q = queues.get(name) ?? [];
    const next = q.shift();
    if (!next) return;
    active.set(name, true);
    Promise.resolve()
      .then(() => next.cb())
      .then(() => {
        active.set(name, false);
        next.resolve();
        pump(name);
      });
  };
  return {
    request(name, options, cb) {
      return new Promise((resolve, reject) => {
        const entry: Entry = { cb, resolve, reject };
        const q = queues.get(name) ?? [];
        queues.set(name, q);
        const signal = options.signal;
        if (signal) {
          if (signal.aborted) {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
            return;
          }
          signal.addEventListener("abort", () => {
            const i = q.indexOf(entry);
            if (i >= 0) {
              q.splice(i, 1);
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            }
          });
        }
        q.push(entry);
        pump(name);
      });
    }
  };
}

describe("TabLeadership — Web Locks (the coordination path)", () => {
  it("the lock holder leads; releasing the lock fails over to the queued tab", async () => {
    const locks = makeFakeLockManager();
    const a = new TabLeadership({ name: "L", id: "a", locks });
    const b = new TabLeadership({ name: "L", id: "b", locks });
    tabs.push(a, b);

    await a.start();
    await b.start();
    await vi.waitFor(() => expect(a.isLeader()).toBe(true));
    expect(b.isLeader()).toBe(false); // queued behind a's exclusive lock

    a.stop(); // releases the lock (and would also auto-release if the tab crashed)
    await vi.waitFor(() => expect(b.isLeader()).toBe(true));
  });

  it("a tab that stops before acquiring never becomes leader (abort), leaving the holder", async () => {
    const locks = makeFakeLockManager();
    const a = new TabLeadership({ name: "L2", id: "a", locks });
    const b = new TabLeadership({ name: "L2", id: "b", locks });
    tabs.push(a, b);
    await a.start();
    await b.start();
    await vi.waitFor(() => expect(a.isLeader()).toBe(true));

    b.stop(); // aborts b's queued request
    a.stop(); // releases the lock; b must NOT pick it up (it aborted)
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(b.isLeader()).toBe(false);
  });
});

describe("TabLeadership — no Web Locks (sole-tab fallback)", () => {
  it("a tab without Web Locks leads itself immediately so its engine still syncs", async () => {
    // locks: null → no coordination primitive; the tab must self-lead (onChange(true))
    // rather than stay a gated follower forever, so a direct caller's engine still syncs.
    const changes: boolean[] = [];
    const t = new TabLeadership({ name: "N", id: "a", locks: null, onChange: (v) => changes.push(v) });
    tabs.push(t);
    await t.start();
    expect(t.isLeader()).toBe(true);
    expect(changes).toEqual([true]);
  });
});
