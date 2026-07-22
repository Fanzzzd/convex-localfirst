import { describe, expect, it, vi } from "vitest";
import { byWorkspace, localTable } from "../../src/core";
import type { PullResponse, PushResponse, SyncScope, SyncTransport } from "../../src/core";
import {
  acceptAllTransport,
  createHarness,
  createTodoManifest,
  offlineTransport,
  serverChange,
} from "./helpers";

const scope = (key: string): SyncScope => ({ kind: "byUser", key });

describe("sync protocol", () => {
  it("pushes an accepted op and marks it acked", async () => {
    const push = vi.fn(
      async (request): Promise<PushResponse> => ({
        accepted: request.mutations.map((op) => ({ opId: op.opId })),
        rejected: [],
        idMaps: [],
        changes: [],
        serverTime: 1,
      }),
    );
    const { engine } = createHarness({ transport: { push, pull: acceptAllTransport().pull } });

    const call = engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "x" });
    await call.server;
    expect(call.status().status).toBe("acked");
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("drains a multi-page backlog via hasMore and clears partial when caught up", async () => {
    const sk = "user:user_a";
    const all = [
      serverChange({ id: "t1", kind: "insert", version: 1, value: { listId: "i", text: "a" } }),
      serverChange({ id: "t2", kind: "insert", version: 2, value: { listId: "i", text: "b" } }),
      serverChange({ id: "t3", kind: "insert", version: 3, value: { listId: "i", text: "c" } }),
    ];
    let pulls = 0;
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      async pull(req) {
        pulls++;
        const cursor = req.cursors[sk] ?? "";
        const remaining = all.filter((c) => c.changeId > cursor);
        const page = remaining.slice(0, 2);
        const last = page[page.length - 1];
        return {
          changes: page,
          cursors: { [sk]: last ? last.changeId : cursor },
          hasMore: { [sk]: remaining.length > 2 },
          serverTime: 1,
        };
      },
    };
    const { engine, store } = createHarness({ transport });
    await engine.syncOnce([{ kind: "byUser", key: sk }]);
    expect((await store.getRows("todos")).map((r) => r._id).sort()).toEqual(["t1", "t2", "t3"]);
    expect(engine.getStatus().partial).toBe(false);
    expect(pulls).toBe(2); // page 1 (hasMore) then page 2 (done)
  });

  it("marks the cache partial when the server reports hasMore but the cursor cannot advance", async () => {
    const sk = "user:user_a";
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      async pull() {
        // Pathological: always claims more, never advances. Must stop + report partial.
        return { changes: [], cursors: { [sk]: "" }, hasMore: { [sk]: true }, serverTime: 1 };
      },
    };
    const { engine } = createHarness({ transport });
    await engine.syncOnce([{ kind: "byUser", key: sk }]);
    expect(engine.getStatus().partial).toBe(true);
  });

  it("keeps operation order monotonic when the wall clock steps backward", async () => {
    // Clock jumps back between the two edits (NTP correction). createdAt must stay
    // strictly increasing so replay order = intent order — the second edit wins.
    const times = [5000, 1000]; // second read is EARLIER than the first
    let i = 0;
    const { engine, store } = createHarness({
      transport: offlineTransport(),
      clock: () => times[Math.min(i++, times.length - 1)],
    });

    await engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "first" }).local;
    await engine.mutate("todos:create", { localId: "t2", listId: "inbox", text: "second" }).local;

    const ops = (await store.getAllOperations()).slice().sort((a, b) => a.createdAt - b.createdAt);
    expect(ops.map((o) => o.id)).toEqual(["t1", "t2"]);
    expect(ops[1].createdAt).toBeGreaterThan(ops[0].createdAt);
  });

  it("rejects (and keeps owed) an op the push response neither accepts nor rejects", async () => {
    // A buggy/malicious server that ACKs nothing must not let us silently mark the op
    // acked — that strands it (no longer owed, never canonical, replayed forever).
    const push = vi.fn(
      async (): Promise<PushResponse> => ({
        accepted: [],
        rejected: [],
        idMaps: [],
        changes: [],
        serverTime: 1,
      }),
    );
    const { engine, store } = createHarness({
      transport: { push, pull: acceptAllTransport().pull },
    });

    const call = engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "x" });
    await expect(call.server).rejects.toThrow(/did not cover operation/);
    // Still owed: it stays pending so the batch path re-pushes it.
    expect((await store.getPendingOperations()).length).toBe(1);
  });

  it("treats a duplicate push (same opId) idempotently on the client", async () => {
    let pushes = 0;
    const transport: SyncTransport = {
      async push(request) {
        pushes++;
        return {
          accepted: request.mutations.map((op) => ({ opId: op.opId })),
          rejected: [],
          idMaps: [],
          // Echo a confirming change so the op is pruned (won't be pushed again).
          changes: request.mutations.map((op) =>
            serverChange({
              id: op.id,
              kind: "insert",
              version: 1,
              opId: op.opId,
              value: { listId: "inbox", text: "x" },
            }),
          ),
          serverTime: 1,
        };
      },
      pull: acceptAllTransport().pull,
    };
    const { engine, store } = createHarness({ transport });

    await engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "x" }).server;
    expect((await store.getPendingOperations()).length).toBe(0);

    // A second sync has nothing to push (op already pruned) — no duplicate.
    await engine.syncOnce([scope("user:user_a")]);
    expect(pushes).toBe(1);
  });

  it("resolves call.server after a LOST ACK: withRetry + server re-delivery (R9), applied once", async () => {
    // The first push commits server-side but its RESPONSE is lost (the transport throws, as a
    // flaky connection would). withRetry retries the SAME op; the server deduped by (userId,opId)
    // and RE-DELIVERS the confirming change. So call.server RESOLVES — it does NOT spuriously
    // reject a committed write — and the row is applied exactly once. This is the exact R9
    // invariant the comment at engine.ts:858-862 claims; locked so a refactor can't regress it
    // (an adversarial sync-path audit specifically doubted this path).
    let pushes = 0;
    const transport: SyncTransport = {
      async push(request) {
        pushes++;
        if (pushes === 1) {
          throw new Error("connection reset (ack lost)"); // committed server-side, response lost
        }
        return {
          accepted: request.mutations.map((op) => ({ opId: op.opId })),
          rejected: [],
          idMaps: [],
          // retry hits the ledger dedupe path → server re-delivers the confirming change
          changes: request.mutations.map((op) =>
            serverChange({
              id: op.id,
              kind: "insert",
              version: 1,
              opId: op.opId,
              value: { listId: "inbox", text: "x" },
            }),
          ),
          serverTime: 1,
        };
      },
      pull: acceptAllTransport().pull,
    };
    const { engine, store } = createHarness({
      transport,
      retry: { retries: 3, baseDelayMs: 1 },
      sleep: async () => {},
    });

    const call = engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "x" });
    await call.server; // RESOLVES despite the lost first ACK — a reject here would throw and fail
    expect(call.status().status).toBe("acked");
    expect(pushes).toBe(2); // attempt 1 threw, attempt 2 (retry) resolved via re-delivery
    expect((await store.getPendingOperations()).length).toBe(0); // pruned by the re-delivered change
    expect((await store.getRows("todos")).length).toBe(1); // applied once — no duplicate row
  });

  it("marks a rejected push as conflicted", async () => {
    const { engine } = createHarness({
      transport: {
        async push(request) {
          return {
            accepted: [],
            rejected: request.mutations.map((op) => ({ opId: op.opId, message: "denied" })),
            idMaps: [],
            changes: [],
            serverTime: 1,
          };
        },
        pull: acceptAllTransport().pull,
      },
    });
    const call = engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "x" });
    await expect(call.server).rejects.toThrow("denied");
    expect(call.status().status).toBe("rejected");
  });

  it("pulls from an empty cursor and then from an existing cursor", async () => {
    const seenCursors: Array<string | null> = [];
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      async pull(request): Promise<PullResponse> {
        seenCursors.push(request.cursors["user:user_a"]);
        const next = request.cursors["user:user_a"] === null ? "c1" : "c2";
        return { changes: [], cursors: { "user:user_a": next }, serverTime: 1 };
      },
    };
    const { engine, store } = createHarness({ transport });

    await engine.syncOnce([scope("user:user_a")]);
    expect(await store.getCursor("user:user_a")).toBe("c1");

    await engine.syncOnce([scope("user:user_a")]);
    expect(await store.getCursor("user:user_a")).toBe("c2");
    expect(seenCursors).toEqual([null, "c1"]);
  });

  it("pulls multiple scopes and advances each cursor", async () => {
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      async pull() {
        return {
          changes: [],
          cursors: { "user:user_a": "ca", "workspace:w1": "cb" },
          serverTime: 1,
        };
      },
    };
    const { engine, store } = createHarness({ transport });
    await engine.syncOnce([scope("user:user_a"), { kind: "byWorkspace", key: "workspace:w1" }]);
    expect(await store.getCursor("user:user_a")).toBe("ca");
    expect(await store.getCursor("workspace:w1")).toBe("cb");
  });

  it("schema mismatch blocks sync safely (no changes applied, no cursor advance)", async () => {
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      async pull() {
        return {
          changes: [
            serverChange({
              id: "t9",
              kind: "insert",
              version: 1,
              value: { listId: "inbox", text: "nope" },
            }),
          ],
          cursors: { "user:user_a": "c1" },
          serverTime: 1,
          schemaMismatch: true,
        };
      },
    };
    const { engine, store } = createHarness({ transport });
    await engine.syncOnce([scope("user:user_a")]);

    expect(engine.getStatus().blockedBySchemaMismatch).toBe(true);
    expect((await store.getCanonicalRows("todos")).length).toBe(0); // change not applied
    expect(await store.getCursor("user:user_a")).toBeNull(); // cursor not advanced

    // Further syncs are a safe no-op while blocked.
    await engine.syncOnce([scope("user:user_a")]);
    expect((await store.getCanonicalRows("todos")).length).toBe(0);
  });

  it("retries a failing pull with backoff and eventually succeeds", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      async pull() {
        attempts++;
        if (attempts < 3) {
          throw new Error("network down");
        }
        return { changes: [], cursors: { "user:user_a": "c1" }, serverTime: 1 };
      },
    };
    const { engine, store } = createHarness({
      transport,
      retry: { retries: 3, baseDelayMs: 10 },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await engine.syncOnce([scope("user:user_a")]);
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 20]); // exponential backoff between retries
    expect(await store.getCursor("user:user_a")).toBe("c1");
  });

  it("throws after exhausting retries", async () => {
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      async pull() {
        throw new Error("always down");
      },
    };
    const { engine } = createHarness({
      transport,
      retry: { retries: 2, baseDelayMs: 1 },
      sleep: async () => {},
    });
    await expect(engine.syncOnce([scope("user:user_a")])).rejects.toThrow("always down");
    expect(engine.getStatus().lastError).toContain("always down");
  });
});

describe("snapshot bootstrap", () => {
  it("evicts rows the completed snapshot did not contain (ghosts), keeping delivered ones", async () => {
    const sk = "u:user_a";
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      async pull() {
        return {
          // Single-page bootstrap: the server snapshot has only t2 — t1 was
          // deleted while this client was behind the GC horizon.
          changes: [
            serverChange({
              id: "t2",
              kind: "insert",
              version: 5,
              scopeKey: sk,
              value: { ownerId: "user_a", listId: "i", text: "kept" },
            }),
          ],
          cursors: { [sk]: "000000000009" },
          hasMore: { [sk]: false },
          snapshotScopes: [sk],
          serverTime: 1,
        } satisfies PullResponse;
      },
    };
    const { engine, store } = createHarness({ transport, userId: "user_a" });
    // Ghost: a canonical row whose delete change was GC'd server-side.
    await store.applyServerChange(
      serverChange({
        id: "t1",
        kind: "insert",
        version: 1,
        value: { ownerId: "user_a", listId: "i", text: "ghost" },
      }),
    );

    await engine.syncOnce([{ kind: "byUser", key: sk }]);
    const rows = await store.getRows("todos");
    expect(rows.map((r) => r._id)).toEqual(["t2"]);
    expect(await store.getCursor(sk)).toBe("000000000009");
  });

  it("an interrupted multi-page bootstrap evicts nothing (rows stay whole)", async () => {
    const sk = "u:user_a";
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      async pull() {
        // Always mid-bootstrap: continuation token, no cursor, hasMore — but the
        // token never advances, so the drain gives up (partial).
        return {
          changes: [
            serverChange({
              id: "t2",
              kind: "insert",
              version: 5,
              scopeKey: sk,
              value: { ownerId: "user_a", listId: "i", text: "page1" },
            }),
          ],
          cursors: {},
          hasMore: { [sk]: true },
          snapshotScopes: [sk],
          bootstrapCursors: { [sk]: "tok" },
          serverTime: 1,
        } satisfies PullResponse;
      },
    };
    const { engine, store } = createHarness({ transport, userId: "user_a" });
    await store.applyServerChange(
      serverChange({
        id: "t1",
        kind: "insert",
        version: 1,
        value: { ownerId: "user_a", listId: "i", text: "old" },
      }),
    );

    await engine.syncOnce([{ kind: "byUser", key: sk }]);
    // t1 must NOT be evicted: the bootstrap never completed. t2 (page 1) applied.
    const ids = (await store.getRows("todos")).map((r) => r._id).sort();
    expect(ids).toEqual(["t1", "t2"]);
    expect(await store.getCursor(sk)).toBeNull(); // cursor untouched mid-bootstrap
    expect(engine.getStatus().partial).toBe(true);
  });
});

describe("membership revocation", () => {
  it("evicts a denied scope's rows and forgets its cursor", async () => {
    const sk = "byWorkspace:w1";
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      async pull() {
        return {
          changes: [],
          cursors: {},
          hasMore: {},
          deniedScopes: [sk],
          serverTime: 1,
        } satisfies PullResponse;
      },
    };
    const manifest = createTodoManifest();
    const wsManifest = {
      ...manifest,
      tables: {
        ...manifest.tables,
        issues: localTable({
          table: "issues",
          idField: "localId",
          scope: byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
          indexes: {},
        }),
      },
    };
    const { engine, store } = createHarness({ transport, userId: "user_a", manifest: wsManifest });
    await store.applyServerChange(
      serverChange({
        table: "issues",
        id: "i1",
        kind: "insert",
        version: 1,
        value: { workspaceId: "w1", title: "secret" },
      }),
    );
    await store.setCursor(sk, "000000000007");

    await engine.syncOnce([{ kind: "byWorkspace", key: sk }]);
    expect(await store.getRows("issues")).toHaveLength(0);
    expect(await store.getCursor(sk)).toBeNull();
  });
});
