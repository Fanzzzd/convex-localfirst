import { describe, expect, it, vi } from "vitest";
import { createConvexTransport, type LocalOperation } from "../../src/core";

const op: LocalOperation = {
  opId: "o1",
  clientId: "A",
  userId: "user_a",
  schemaVersion: 1,
  functionName: "todos:create",
  table: "todos",
  kind: "insert",
  id: "t1",
  args: {},
  value: { text: "hi" },
  createdAt: 1,
  status: "pending"
};

const storedChange = {
  changeId: "000000000001",
  scopeKey: "u:user_a",
  table: "todos",
  localId: "t1",
  kind: "insert" as const,
  data: { text: "hi", ownerId: "user_a" },
  version: 1,
  serverTime: 5,
  opId: "o1"
};

describe("createConvexTransport", () => {
  it("serializes ops for push and maps server changes to client shape", async () => {
    const mutation = vi.fn(async () => ({
      accepted: [{ opId: "o1" }],
      rejected: [],
      idMaps: [{ table: "todos", localId: "t1", serverId: "srv1" }],
      changes: [storedChange],
      serverTime: 5
    }));
    const transport = createConvexTransport({
      client: { mutation, query: vi.fn() },
      push: "ref:push",
      pull: "ref:pull",
      clientId: "A",
      userId: "user_a"
    });

    const res = await transport.push({ clientId: "A", userId: "user_a", schemaVersion: 1, mutations: [op] });

    // Op was serialized with localId (not id).
    expect(mutation).toHaveBeenCalledWith("ref:push", expect.objectContaining({ userId: "user_a", schemaVersion: 1 }));
    const sent = mutation.mock.calls[0][1] as { mutations: Array<{ localId: string; value: unknown }> };
    expect(sent.mutations[0]).toMatchObject({ localId: "t1", value: { text: "hi" } });

    // Server change mapped to client ServerChange (localId -> id, data -> value).
    expect(res.changes[0]).toMatchObject({ id: "t1", value: { text: "hi", ownerId: "user_a" }, changeId: "000000000001" });
    expect(res.idMaps[0]).toMatchObject({ localId: "t1", serverId: "srv1" });
  });

  it("maps pull scopes and changes, passing cursors through", async () => {
    const query = vi.fn(async () => ({ changes: [storedChange], cursors: { "u:user_a": "000000000001" }, serverTime: 5 }));
    const transport = createConvexTransport({
      client: { mutation: vi.fn(), query },
      push: "ref:push",
      pull: "ref:pull",
      clientId: "B",
      userId: "user_a"
    });

    const res = await transport.pull({
      clientId: "B",
      userId: "user_a",
      schemaVersion: 1,
      scopes: [{ kind: "byUser", key: "u:user_a" }],
      cursors: { "u:user_a": null }
    });

    const sent = query.mock.calls[0][1] as { scopes: Array<{ kind: string; value?: string }> };
    expect(sent.scopes[0]).toEqual({ kind: "byUser", value: "user_a" });
    expect(res.changes[0]).toMatchObject({ id: "t1", value: { text: "hi", ownerId: "user_a" } });
    expect(res.cursors["u:user_a"]).toBe("000000000001");
  });

  it("subscribe watches the pull query and forwards its fires as a doorbell", () => {
    let fire: (() => void) | undefined;
    const dispose = vi.fn();
    const watch = { onUpdate: vi.fn((cb: () => void) => ((fire = cb), dispose)) };
    const watchQuery = vi.fn(() => watch);
    const transport = createConvexTransport({
      client: { mutation: vi.fn(), query: vi.fn(), watchQuery },
      push: "ref:push",
      pull: "ref:pull",
      clientId: "C",
      userId: "user_a"
    });

    const onChange = vi.fn();
    const unsubscribe = transport.subscribe!(
      { clientId: "C", userId: "user_a", schemaVersion: 1, scopes: [{ kind: "byUser", key: "u:user_a" }], cursors: { "u:user_a": null } },
      onChange
    );

    // Watched the SAME pull query, with the scope/cursor mapping pull uses.
    const sent = watchQuery.mock.calls[0][1] as { scopes: Array<{ kind: string; value?: string }>; cursors: Record<string, unknown> };
    expect(watchQuery.mock.calls[0][0]).toBe("ref:pull");
    expect(sent.scopes[0]).toEqual({ kind: "byUser", value: "user_a" });
    expect(sent.cursors).toEqual({ "u:user_a": null });

    fire?.(); // server-side change → doorbell
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("omits subscribe when the client is not reactive (no watchQuery)", () => {
    const transport = createConvexTransport({
      client: { mutation: vi.fn(), query: vi.fn() },
      push: "ref:push",
      pull: "ref:pull",
      clientId: "D",
      userId: "user_a"
    });
    expect(transport.subscribe).toBeUndefined();
  });
});
