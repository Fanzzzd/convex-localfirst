import "fake-indexeddb/auto";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  IndexedDbStore,
  byUser,
  defineLocalFirstManifest,
  localMutation,
  localQuery,
  localTable,
  type RowValue,
  type SyncTransport,
} from "../../src/core/index.js";

// Minimal convex/react stub (offline; local-first never touches it).
vi.mock("convex/react", () => ({
  // oxlint-disable-next-line typescript/no-extraneous-class -- stub for a class the consumer instantiates with `new`
  ConvexReactClient: class {},
  ConvexProvider: ({ children }: { children: React.ReactNode }) => children,
  Authenticated: ({ children }: { children: React.ReactNode }) => children,
  Unauthenticated: () => null,
  AuthLoading: () => null,
  useConvex: () => null,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
}));

const { ConvexProvider, ConvexReactClient, useMutation, useQuery, useSyncRecovery } =
  await import("../../src/react/index");
const client = new ConvexReactClient("http://localhost");

function manifest(schemaVersion = 1) {
  return defineLocalFirstManifest({
    schemaVersion,
    tables: {
      todos: localTable({
        table: "todos",
        idField: "localId",
        scope: byUser("ownerId"),
        indexes: {},
      }),
    },
    queries: {
      "todos:list": localQuery<{ listId: string }, readonly RowValue[]>({
        kind: "query",
        name: "todos:list",
        table: "todos",
        initial: [],
        run: (rows, args) => rows.filter((r) => r.listId === args.listId),
      }),
    },
    mutations: {
      "todos:create": localMutation<{ localId: string; listId: string; text: string }>({
        kind: "mutation",
        name: "todos:create",
        table: "todos",
        plan: (args) => ({
          kind: "insert",
          table: "todos",
          id: args.localId,
          value: { ownerId: "user_a", listId: args.listId, text: args.text, done: false },
        }),
      }),
    },
  });
}

// Offline: push never settles (todo stays pending locally).
const offline: SyncTransport = {
  push: () => new Promise(() => {}),
  pull: () => new Promise(() => {}),
};

function Todos() {
  const todos = useQuery<{ listId: string }, readonly RowValue[]>(
    "todos:list",
    { listId: "inbox" },
    { initial: [] },
  );
  const create = useMutation<{ localId: string; listId: string; text: string }, unknown>(
    "todos:create",
  );
  return (
    <div>
      <span data-testid="count">{todos?.length ?? -1}</span>
      <span data-testid="first">{todos?.[0]?.text ?? ""}</span>
      <button
        type="button"
        onClick={() => void create({ localId: "t1", listId: "inbox", text: "offline todo" }).local}
      >
        add
      </button>
    </div>
  );
}

afterEach(() => cleanup());

describe("offline-first persistence (DoD steps 1-3)", () => {
  it("creates a todo offline and still shows it after a simulated refresh", async () => {
    const dbOpts = { databaseName: "persist-test", namespace: "user_a" } as const;

    // First "page load": create a todo offline.
    const store1 = new IndexedDbStore(dbOpts);
    const { unmount } = render(
      <ConvexProvider
        client={client}
        localFirst={{
          manifest: manifest(),
          transport: offline,
          store: store1,
          userId: "user_a",
          nameOf: (r) => String(r),
        }}
      >
        <Todos />
      </ConvexProvider>,
    );
    await act(async () => {
      screen.getByText("add").click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));

    // "Refresh": tear down React + the store connection, mount a fresh store on the same IndexedDB.
    unmount();
    (await store1._database()).close();

    const store2 = new IndexedDbStore(dbOpts);
    render(
      <ConvexProvider
        client={client}
        localFirst={{
          manifest: manifest(),
          transport: offline,
          store: store2,
          userId: "user_a",
          nameOf: (r) => String(r),
        }}
      >
        <Todos />
      </ConvexProvider>,
    );

    // The todo is still there after reload, even though it was never pushed.
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
    expect(screen.getByTestId("first").textContent).toBe("offline todo");
    expect((await store2.getPendingOperations()).length).toBe(1); // still pending (offline)
  });

  it("surfaces pending operations from the older default namespace after a schema bump", async () => {
    const databaseName = "schema-recovery-test";
    const legacy = new IndexedDbStore({ databaseName, namespace: "user_a" });
    await legacy.enqueueOperation({
      opId: "legacy-op",
      clientId: "old-client",
      userId: "user_a",
      schemaVersion: 1,
      functionName: "todos:create",
      table: "todos",
      kind: "insert",
      id: "legacy-todo",
      args: {},
      value: { ownerId: "user_a", listId: "inbox", text: "offline v1" },
      createdAt: 1,
      status: "pending",
    });
    (await legacy._database()).close();

    function Recovery() {
      const recovery = useSyncRecovery();
      return (
        <span data-testid="legacy-recovery">
          {recovery.olderSchemaOperations.map((op) => `${op.namespace}:${op.opId}`).join(",")}
        </span>
      );
    }

    render(
      <ConvexProvider
        client={client}
        localFirst={{
          manifest: manifest(2),
          transport: offline,
          databaseName,
          userId: "user_a",
          nameOf: String,
        }}
      >
        <Recovery />
      </ConvexProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("legacy-recovery").textContent).toBe("user_a:legacy-op"),
    );
  });
});
