import { describe, expect, it, vi } from "vitest";
import { collection, type RowValue, type ServerChange, type SyncTransport } from "../src";
import { acceptAllTransport, createHarness } from "./helpers";

// Reactive pull (transport.subscribe): a content-free "doorbell" fire makes the
// engine drain the scope. The hard part is the lifecycle — resubscribe at the
// advanced cursor (so the watched window stays small) WITHOUT spinning into an
// empty-fire→resubscribe loop, coalesce bursts, and tear down cleanly. This test
// drives that logic against a fake reactive transport (no live backend).

const cid = (n: number) => String(n).padStart(12, "0");

/** A fake server: an append-only change log + a reactive feed. `append` is the
 *  server-side write that rings every live doorbell (like a new Convex change). */
function watchableServer() {
  const log: ServerChange[] = [];
  const listeners = new Set<() => void>();
  let pullCalls = 0;

  const changesAfter = (cursor: string | null) => (cursor ? log.filter((c) => c.changeId > cursor) : log.slice());

  const transport: SyncTransport = {
    async push() {
      return { accepted: [], rejected: [], idMaps: [], changes: [], serverTime: 1 };
    },
    async pull(req) {
      pullCalls++;
      const key = req.scopes[0]?.key ?? "u:user_a";
      const changes = changesAfter(req.cursors[key] ?? null);
      const cursors: Record<string, string> = {};
      if (changes.length) cursors[key] = changes[changes.length - 1]!.changeId;
      return { changes, cursors, serverTime: 1 };
    },
    subscribe(_req, onChange) {
      listeners.add(onChange);
      // Mimic Convex: a fresh subscription fires once when its first result lands.
      // This is what would loop forever without the resubscribe-on-advance guard.
      queueMicrotask(() => {
        if (listeners.has(onChange)) onChange();
      });
      return () => listeners.delete(onChange);
    }
  };

  let n = 0;
  const append = (id: string) => {
    n++;
    log.push({
      changeId: cid(n),
      scopeKey: "u:user_a",
      table: "todos",
      id,
      kind: "insert",
      value: { ownerId: "user_a", listId: "L", text: id, done: false, createdAt: n, updatedAt: n },
      version: 1,
      serverTime: n
    });
    for (const l of Array.from(listeners)) l();
  };

  return { transport, append, listeners, pullCalls: () => pullCalls };
}

const settle = () => vi.waitFor(() => Promise.resolve(), { timeout: 1000 });
const ids = async (engine: { tableRows(t: string): Promise<readonly RowValue[]> }) =>
  (await engine.tableRows("todos")).map((r) => r._id).sort();

describe("reactive pull (engine.watchPlan)", () => {
  it("reports reactive only when the transport can subscribe", () => {
    expect(createHarness({ transport: acceptAllTransport() }).engine.reactive).toBe(false);
    expect(createHarness({ transport: watchableServer().transport }).engine.reactive).toBe(true);
  });

  it("watchPlan returns null for a non-reactive transport (caller falls back to poll)", () => {
    const { engine } = createHarness({ transport: acceptAllTransport() });
    expect(engine.watchPlan(collection<RowValue>("todos"))).toBeNull();
  });

  it("drains the scope on every server change (true server push)", async () => {
    const server = watchableServer();
    const { engine } = createHarness({ transport: server.transport });
    const unwatch = engine.watchPlan(collection<RowValue>("todos"));
    expect(unwatch).not.toBeNull();

    server.append("a"); // server-side write rings the doorbell
    await vi.waitFor(async () => expect(await ids(engine)).toEqual(["a"]));

    server.append("b");
    await vi.waitFor(async () => expect(await ids(engine)).toEqual(["a", "b"]));

    unwatch!();
  });

  it("does not leak or multiply subscriptions, and stops pulling once idle (no loop)", async () => {
    const server = watchableServer();
    const { engine } = createHarness({ transport: server.transport });
    const unwatch = engine.watchPlan(collection<RowValue>("todos"))!;

    server.append("a");
    await vi.waitFor(async () => expect(await ids(engine)).toEqual(["a"]));
    await settle();

    // Exactly one live subscription (old one disposed on each resubscribe), and the
    // empty re-fire after resubscribe did NOT trigger another pull (the guard holds).
    expect(server.listeners.size).toBe(1);
    const before = server.pullCalls();
    await settle();
    await settle();
    expect(server.pullCalls()).toBe(before); // idle: no spinning

    unwatch();
    expect(server.listeners.size).toBe(0); // torn down cleanly
  });

  it("coalesces a burst of changes into the caught-up state", async () => {
    const server = watchableServer();
    const { engine } = createHarness({ transport: server.transport });
    const unwatch = engine.watchPlan(collection<RowValue>("todos"))!;

    // Three writes before anything settles — the mid-drain ones coalesce.
    server.append("a");
    server.append("b");
    server.append("c");
    await vi.waitFor(async () => expect(await ids(engine)).toEqual(["a", "b", "c"]));

    unwatch();
  });

  it("watchQuery (declarative useQuery path) is reactive too, scoped from the definition", async () => {
    const server = watchableServer();
    const { engine } = createHarness({ transport: server.transport });
    // "todos:list" is a declarative query in the test manifest (byUser scope).
    const unwatch = engine.watchQuery("todos:list", { listId: "L" });
    expect(unwatch).not.toBeNull();

    server.append("a");
    await vi.waitFor(async () => expect(await ids(engine)).toEqual(["a"]));

    unwatch!();
    expect(server.listeners.size).toBe(0);
  });

  it("watchQuery returns null for an unknown query or a non-reactive transport", () => {
    expect(createHarness({ transport: watchableServer().transport }).engine.watchQuery("nope:missing", {})).toBeNull();
    expect(createHarness({ transport: acceptAllTransport() }).engine.watchQuery("todos:list", { listId: "L" })).toBeNull();
  });

  it("surfaces a failing reactive drain on status.lastError (not silently swallowed)", async () => {
    const server = watchableServer();
    // Make the drain fail: pull rejects.
    const failing: SyncTransport = {
      ...server.transport,
      async pull() {
        throw new Error("pull boom");
      }
    };
    const { engine } = createHarness({ transport: failing });
    const unwatch = engine.watchPlan(collection<RowValue>("todos"))!;
    server.append("a"); // doorbell → drain → pull throws
    await vi.waitFor(() => expect(engine.getStatus().lastError).toContain("boom"));
    unwatch();
  });

  it("refcounts per-scope watches: N hooks on one scope share ONE subscription", async () => {
    const server = watchableServer();
    const { engine } = createHarness({ transport: server.transport });
    const plan = collection<RowValue>("todos");
    // Two mounted hooks watch the SAME scope (e.g. a board with two useLiveQuery on one workspace).
    const unwatchA = engine.watchPlan(plan);
    const unwatchB = engine.watchPlan(plan);
    expect(unwatchA).not.toBeNull();
    expect(unwatchB).not.toBeNull();
    // ONE shared underlying subscription + drain loop, not two (no thundering herd).
    await vi.waitFor(() => expect(server.listeners.size).toBe(1));

    // A server change drains once and both hooks see it.
    server.append("a");
    await vi.waitFor(async () => expect(await ids(engine)).toEqual(["a"]));
    await settle();
    expect(server.listeners.size).toBe(1); // still one (resubscribe-on-advance keeps it at 1)

    // Releasing ONE watcher keeps the shared subscription alive for the other.
    unwatchA!();
    expect(server.listeners.size).toBe(1);
    // Idempotent: releasing the same handle twice is a no-op (doesn't drop the refcount again).
    unwatchA!();
    expect(server.listeners.size).toBe(1);

    // Releasing the LAST watcher tears the subscription down.
    unwatchB!();
    await vi.waitFor(() => expect(server.listeners.size).toBe(0));

    // A fresh watch after full teardown starts a new subscription cleanly.
    const unwatchC = engine.watchPlan(plan)!;
    await vi.waitFor(() => expect(server.listeners.size).toBe(1));
    unwatchC();
  });

  it("delivers nothing after teardown", async () => {
    const server = watchableServer();
    const { engine } = createHarness({ transport: server.transport });
    const unwatch = engine.watchPlan(collection<RowValue>("todos"))!;
    server.append("a");
    await vi.waitFor(async () => expect(await ids(engine)).toEqual(["a"]));

    unwatch();
    server.append("b"); // no live doorbell
    await settle();
    expect(await ids(engine)).toEqual(["a"]); // "b" never pulled
  });
});
