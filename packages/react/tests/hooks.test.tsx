import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  byUser,
  byWorkspace,
  MemoryLocalStore,
  defineLocalFirstManifest,
  localMutation,
  localQuery,
  localTable,
  type LocalFirstMutationCall,
  type RowValue,
  type SyncTransport
} from "@convex-localfirst/core";

// Controllable spies for the mocked Convex react module.
const h = vi.hoisted(() => ({
  convexUseQueryCalls: [] as Array<{ ref: unknown; args: unknown }>,
  convexMutation: vi.fn(async () => ({ viaConvex: true }))
}));

vi.mock("convex/react", () => ({
  ConvexReactClient: class {
    constructor(_url?: string) {}
  },
  ConvexProvider: ({ children }: { children: React.ReactNode }) => children,
  Authenticated: ({ children }: { children: React.ReactNode }) => children,
  Unauthenticated: () => null,
  AuthLoading: () => null,
  useConvex: () => null,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
  useQuery: (ref: unknown, args: unknown) => {
    h.convexUseQueryCalls.push({ ref, args });
    return args === "skip" ? undefined : { viaConvex: true, ref: String(ref) };
  },
  useMutation: () => h.convexMutation
}));

// Imported AFTER the mock so the wrapper picks up the stubbed convex/react.
const { ConvexProvider, ConvexReactClient, collection, many, useLiveQuery, useMutation, useQuery, useSyncStatus } =
  await import("../src/index");

function manifest() {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      todos: localTable({
        table: "todos",
        idField: "localId",
        scope: byUser("ownerId"),
        indexes: {}
      }),
      issues: localTable({
        table: "issues",
        idField: "localId",
        scope: byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "m" }),
        indexes: {}
      }),
      comments: localTable({
        table: "comments",
        idField: "localId",
        scope: byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "m" }),
        indexes: {}
      })
    },
    queries: {
      "todos:list": localQuery<{ listId: string }, readonly RowValue[]>({
        kind: "query",
        name: "todos:list",
        table: "todos",
        initial: [],
        run: (rows, args) => rows.filter((row) => row.listId === args.listId)
      })
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
          value: { ownerId: "user_a", listId: args.listId, text: args.text, done: false }
        })
      })
    }
  });
}

const acceptAll: SyncTransport = {
  async push(request) {
    return {
      accepted: request.mutations.map((op) => ({ opId: op.opId, serverResult: { ok: true } })),
      rejected: [],
      idMaps: [],
      changes: [],
      serverTime: 1
    };
  },
  async pull() {
    return { changes: [], cursors: {}, serverTime: 1 };
  }
};

function wrap(ui: React.ReactNode) {
  return (
    <ConvexProvider
      client={new ConvexReactClient("http://localhost")}
      localFirst={{ manifest: manifest(), transport: acceptAll, userId: "user_a", nameOf: (ref) => String(ref) }}
    >
      {ui}
    </ConvexProvider>
  );
}

afterEach(() => {
  cleanup();
  h.convexUseQueryCalls.length = 0;
  h.convexMutation.mockClear();
});

let captured: LocalFirstMutationCall<unknown> | undefined;

function Todos() {
  const todos = useQuery<{ listId: string }, readonly RowValue[]>("todos:list", { listId: "inbox" }, { initial: [] });
  const create = useMutation<{ localId: string; listId: string; text: string }, unknown>("todos:create");
  return (
    <div>
      <span data-testid="count">{todos?.length ?? -1}</span>
      <button
        type="button"
        onClick={() => {
          captured = create({ localId: "t1", listId: "inbox", text: "hi" }) as LocalFirstMutationCall<unknown>;
        }}
      >
        add
      </button>
    </div>
  );
}

function LiveTodos() {
  const todos = useLiveQuery(collection<RowValue>("todos").where((row) => row.listId === "inbox").order("text"));
  const create = useMutation<{ localId: string; listId: string; text: string }, unknown>("todos:create");
  return (
    <div>
      <span data-testid="live-count">{todos?.length ?? -1}</span>
      <button
        type="button"
        onClick={() => {
          captured = create({ localId: "t1", listId: "inbox", text: "hi" }) as LocalFirstMutationCall<unknown>;
        }}
      >
        addlive
      </button>
    </div>
  );
}

describe("react hooks", () => {
  it("useLiveQuery fails closed for a workspace table queried without .scope() (no cross-workspace leak)", async () => {
    const store = new MemoryLocalStore();
    await store.applyServerChange({
      changeId: "c1", scopeKey: "byWorkspace:w1", table: "issues", id: "i1", kind: "insert",
      value: { workspaceId: "w1", title: "x" }, version: 1, serverTime: 1
    });
    await store.applyServerChange({
      changeId: "c2", scopeKey: "byWorkspace:w2", table: "issues", id: "i2", kind: "insert",
      value: { workspaceId: "w2", title: "y" }, version: 1, serverTime: 1
    });

    function NoScope() {
      const issues = useLiveQuery(collection<RowValue>("issues"));
      return <span data-testid="noscope">{issues?.length ?? -1}</span>;
    }
    function Scoped() {
      const issues = useLiveQuery(collection<RowValue>("issues").scope({ workspaceId: "w1" }));
      return <span data-testid="scoped">{issues?.length ?? -1}</span>;
    }

    render(
      <ConvexProvider
        client={new ConvexReactClient("http://localhost")}
        localFirst={{ manifest: manifest(), transport: acceptAll, store, userId: "user_a", nameOf: (ref) => String(ref) }}
      >
        <NoScope />
        <Scoped />
      </ConvexProvider>
    );

    // No .scope() on a byWorkspace table -> fail closed (0), even with w1+w2 cached.
    await waitFor(() => expect(screen.getByTestId("noscope").textContent).toBe("0"));
    // With the scope -> only the w1 row.
    await waitFor(() => expect(screen.getByTestId("scoped").textContent).toBe("1"));
  });

  it("useLiveQuery attaches a relation (issue -> comments) from another local table", async () => {
    const store = new MemoryLocalStore();
    const seed = (table: string, id: string, value: Record<string, unknown>) =>
      store.applyServerChange({
        changeId: `c-${id}`, scopeKey: "byWorkspace:w1", table, id, kind: "insert",
        value: { workspaceId: "w1", ...value }, version: 1, serverTime: 1
      });
    await seed("issues", "i1", { title: "Bug", createdAt: 1 });
    await seed("comments", "cm1", { issueId: "i1", body: "a" });
    await seed("comments", "cm2", { issueId: "i1", body: "b" });

    function IssueComments() {
      const issues =
        useLiveQuery(collection<RowValue>("issues").scope({ workspaceId: "w1" }).related("comments", many<RowValue>("comments", "issueId"))) ?? [];
      return <span data-testid="cc">{issues[0] ? (issues[0].comments as unknown[]).length : -1}</span>;
    }

    render(
      <ConvexProvider
        client={new ConvexReactClient("http://localhost")}
        localFirst={{ manifest: manifest(), transport: acceptAll, store, userId: "user_a", nameOf: (ref) => String(ref) }}
      >
        <IssueComments />
      </ConvexProvider>
    );
    await waitFor(() => expect(screen.getByTestId("cc").textContent).toBe("2"));
  });

  it("useLiveQuery reads the local derived view and updates reactively after a mutation", async () => {
    render(wrap(<LiveTodos />));
    // Loads to an empty array (not stuck undefined) and does not infinite-loop.
    await waitFor(() => expect(screen.getByTestId("live-count").textContent).toBe("0"));

    await act(async () => {
      screen.getByText("addlive").click();
      await captured?.local;
    });

    await waitFor(() => expect(screen.getByTestId("live-count").textContent).toBe("1"));
  });

  it("local-first useQuery honors initial value and updates after a local mutation", async () => {
    render(wrap(<Todos />));
    expect(screen.getByTestId("count").textContent).toBe("0"); // initial value

    await act(async () => {
      screen.getByText("add").click();
      await captured?.local;
    });

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
  });

  it("local-first useQuery skips the Convex subscription", async () => {
    render(wrap(<Todos />));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("0"));
    // The wrapper still calls Convex's hook, but with "skip" for local-first functions.
    const listCalls = h.convexUseQueryCalls.filter((c) => String(c.ref) === "todos:list");
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every((c) => c.args === "skip")).toBe(true);
  });

  it("useMutation result is awaitable and exposes .local and .server", async () => {
    render(wrap(<Todos />));
    await act(async () => {
      screen.getByText("add").click();
    });
    expect(captured).toBeDefined();
    expect(typeof captured?.then).toBe("function"); // awaitable like a promise
    await expect(captured?.local).resolves.toMatchObject({ table: "todos", id: "t1" });
    await expect(captured?.server).resolves.toEqual({ ok: true });
    await expect(captured).resolves.toEqual({ ok: true }); // await call === server result
  });

  it("falls back to Convex for non-local-first queries", async () => {
    function Other() {
      const value = useQuery<{ a: number }, { viaConvex?: boolean }>("other:fn", { a: 1 });
      return <span data-testid="other">{value?.viaConvex ? "convex" : "none"}</span>;
    }
    render(wrap(<Other />));
    await waitFor(() => expect(screen.getByTestId("other").textContent).toBe("convex"));
    // Convex hook was called with the real args (not skip) for a non-local fn.
    const calls = h.convexUseQueryCalls.filter((c) => String(c.ref) === "other:fn");
    expect(calls.some((c) => c.args !== "skip")).toBe(true);
  });

  it("falls back to Convex for non-local-first mutations", async () => {
    function OtherMutation() {
      const run = useMutation<{ x: number }, { viaConvex: boolean }>("other:mutate");
      return (
        <button type="button" onClick={() => void run({ x: 1 })}>
          run
        </button>
      );
    }
    render(wrap(<OtherMutation />));
    await act(async () => {
      screen.getByText("run").click();
    });
    expect(h.convexMutation).toHaveBeenCalledWith({ x: 1 });
  });

  it("useSyncStatus reports pending mutations", async () => {
    function WithStatus() {
      const status = useSyncStatus();
      const create = useMutation<{ localId: string; listId: string; text: string }, unknown>("todos:create");
      return (
        <div>
          <span data-testid="pending">{status.pendingMutations}</span>
          <button type="button" onClick={() => void create({ localId: "tx", listId: "inbox", text: "p" })}>
            go
          </button>
        </div>
      );
    }
    render(wrap(<WithStatus />));
    await act(async () => {
      screen.getByText("go").click();
    });
    // After the mutation acks (acceptAll), the pending count must settle back to 0 — a real
    // lifecycle assertion (it fails if the count leaks/sticks), not the old `>= 0` tautology.
    await waitFor(() => expect(Number(screen.getByTestId("pending").textContent)).toBe(0));
  });
});
