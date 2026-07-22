import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  type PushResponse,
  type ServerChange,
  type SyncTransport,
} from "../../src/core";
import { createHarness } from "./helpers";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Push transport that confirms each pushed op with a matching server change (so ops are
 *  pruned and canonical is built), and records every mutation it received. */
function echoTransport(): SyncTransport & { received: string[] } {
  let version = 100;
  const received: string[] = [];
  return {
    received,
    async push(request): Promise<PushResponse> {
      const changes: ServerChange[] = request.mutations.map((op) => {
        received.push(`${op.kind}:${op.id}`);
        version++;
        return {
          changeId: `c_${version}`,
          scopeKey: "u:user_a",
          table: op.table,
          id: op.id,
          kind: op.kind,
          value: op.value,
          patch: op.patch,
          version,
          serverTime: version,
          opId: op.opId,
        };
      });
      return {
        accepted: request.mutations.map((op) => ({ opId: op.opId, serverResult: { ok: true } })),
        rejected: [],
        idMaps: [],
        changes,
        serverTime: version,
      };
    },
    async pull() {
      return { changes: [], cursors: {}, serverTime: version };
    },
  };
}

describe("undo/redo (DX v4 §7)", () => {
  it("undoes and redoes an insert (round-trip)", async () => {
    const { engine } = createHarness({ transport: echoTransport() });
    const call = engine.mutate("todos:create", { listId: "l1", text: "A" });
    await call.local;
    const id = call.id;
    expect(await engine.getRow("todos", id)).toBeTruthy();
    expect(engine.canUndo()).toBe(true);

    await engine.undo();
    expect(await engine.getRow("todos", id)).toBeUndefined();
    expect(engine.canUndo()).toBe(false);
    expect(engine.canRedo()).toBe(true);

    await engine.redo();
    const back = await engine.getRow("todos", id);
    expect(back).toBeTruthy();
    expect(back?.text).toBe("A");
    expect(engine.canUndo()).toBe(true);
    expect(engine.canRedo()).toBe(false);
  });

  it("undoes and redoes a patch (field-level inverse)", async () => {
    const { engine } = createHarness({ transport: echoTransport() });
    const call = engine.mutate("todos:create", { listId: "l1", text: "A" });
    await call.local;
    const id = call.id;
    await engine.mutate("todos:toggle", { id, done: true }).local;
    expect((await engine.getRow("todos", id))?.done).toBe(true);

    await engine.undo(); // undoes the toggle
    expect((await engine.getRow("todos", id))?.done).toBe(false);

    await engine.redo();
    expect((await engine.getRow("todos", id))?.done).toBe(true);
  });

  it("undoes and redoes a delete (re-inserts the before row)", async () => {
    const { engine } = createHarness({ transport: echoTransport() });
    const call = engine.mutate("todos:create", { listId: "l1", text: "keep" });
    await call.server; // confirm so canonical holds the row
    const id = call.id;
    await engine.mutate("todos:remove", { id }).server;
    expect(await engine.getRow("todos", id)).toBeUndefined();

    await engine.undo(); // undoes the delete → re-insert
    const back = await engine.getRow("todos", id);
    expect(back?.text).toBe("keep");

    await engine.redo(); // redo the delete
    expect(await engine.getRow("todos", id)).toBeUndefined();
  });

  it("undoes an atomic batch group as ONE unit", async () => {
    const { engine } = createHarness({ transport: echoTransport() });
    let idA = "";
    let idB = "";
    await engine.batch(() => {
      const a = engine.mutate("todos:create", { listId: "l1", text: "A" });
      const b = engine.mutate("todos:create", { listId: "l1", text: "B" });
      idA = a.id;
      idB = b.id;
    }).local;
    expect(await engine.getRow("todos", idA)).toBeTruthy();
    expect(await engine.getRow("todos", idB)).toBeTruthy();

    await engine.undo(); // one undo removes BOTH
    expect(await engine.getRow("todos", idA)).toBeUndefined();
    expect(await engine.getRow("todos", idB)).toBeUndefined();
    expect(engine.canUndo()).toBe(false);

    await engine.redo(); // one redo restores BOTH
    expect(await engine.getRow("todos", idA)).toBeTruthy();
    expect(await engine.getRow("todos", idB)).toBeTruthy();
  });

  it("emits ordinary syncable ops — the server receives the undo", async () => {
    const transport = echoTransport();
    const { engine } = createHarness({ transport });
    const call = engine.mutate("todos:create", { listId: "l1", text: "A" });
    await call.server;
    const id = call.id;
    transport.received.length = 0;

    await engine.undo(); // emits a delete
    for (let i = 0; i < 50 && !transport.received.includes(`delete:${id}`); i++) await flush();
    expect(transport.received).toContain(`delete:${id}`);
  });

  it("undoing a patch on a remotely-deleted row is a no-op that drops the entry", async () => {
    const { engine, store } = createHarness({ transport: echoTransport() });
    const call = engine.mutate("todos:create", { listId: "l1", text: "A" });
    await call.server;
    const id = call.id;
    await engine.mutate("todos:toggle", { id, done: true }).server;

    // A remote delete removes the row (higher version), with no pending local ops left.
    await store.applyServerChanges([
      {
        changeId: "rd",
        scopeKey: "u:user_a",
        table: "todos",
        id,
        kind: "delete",
        version: 9999,
        serverTime: 9999,
      },
    ]);
    expect(await engine.getRow("todos", id)).toBeUndefined();
    expect(engine.canUndo()).toBe(true);

    await engine.undo(); // pops the toggle patch entry → dropped (row gone, not resurrected)
    expect(await engine.getRow("todos", id)).toBeUndefined();
    expect(engine.canRedo()).toBe(false); // nothing emitted → no redo recorded
  });

  it("caps the undo stack at 100 entries per scope", async () => {
    const { engine } = createHarness({ transport: echoTransport() });
    const call = engine.mutate("todos:create", { listId: "l1", text: "A" });
    await call.local;
    const id = call.id;
    // 130 patches → 130 undo entries, capped to 100 (oldest fall off).
    for (let i = 0; i < 130; i++) {
      await engine.mutate("todos:toggle", { id, done: i % 2 === 0 }).local;
    }
    let undos = 0;
    while (engine.canUndo() && undos < 500) {
      await engine.undo();
      undos++;
    }
    // 100 patch entries + the initial insert entry are undoable (the 30 oldest patches
    // were evicted by the cap, but the insert predates them all and is a separate action).
    expect(undos).toBeLessThanOrEqual(101);
    expect(undos).toBeGreaterThanOrEqual(100);
  });

  it("clears the stacks when local data is cleared (logout)", async () => {
    const store = new MemoryLocalStore();
    const { engine } = createHarness({ store, transport: echoTransport() });
    await engine.mutate("todos:create", { listId: "l1", text: "A" }).local;
    expect(engine.canUndo()).toBe(true);

    await store.clear();
    await flush();
    expect(engine.canUndo()).toBe(false);
    expect(engine.canRedo()).toBe(false);
  });
});
