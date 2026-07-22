import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  byWorkspace,
  defineLocalFirstManifest,
  localMutation,
  localTable,
  type ClientCanConfig,
  type LocalFirstManifest,
  type PullResponse,
  type PushResponse,
  type SyncTransport
} from "../../src/core/index.js";

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
  useQuery: () => undefined,
  useMutation: () => vi.fn(async () => ({}))
}));

const { ConvexProvider, ConvexReactClient, useCan, useMutation, useRole, useUndo } = await import(
  "../../src/react/index"
);

type DocRow = { workspace_id: string; title: string; created_by: string } & Record<string, unknown>;
const docsClientCan: ClientCanConfig<DocRow, number> = { write: ({ role }) => (role as number) >= 15 };

function manifest(): LocalFirstManifest {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      docs: localTable({
        table: "docs",
        idField: "id",
        scope: byWorkspace({ workspaceIdField: "workspace_id", membershipTable: "ws_members" }),
        indexes: { byWorkspace: ["workspace_id"] },
        clientCan: docsClientCan as ClientCanConfig
      })
    },
    queries: {},
    mutations: {
      "docs:create": localMutation<{ id: string; workspace_id: string; title: string }>({
        kind: "mutation",
        name: "docs:create",
        table: "docs",
        operationKind: "insert",
        plan: (args, ctx) => ({
          kind: "insert",
          table: "docs",
          id: args.id,
          value: { workspace_id: args.workspace_id, title: args.title, created_by: ctx.userId ?? "anon" }
        })
      }),
      "docs:rename": localMutation<{ id: string; title: string }>({
        kind: "mutation",
        name: "docs:rename",
        table: "docs",
        operationKind: "patch",
        plan: (args) => ({ kind: "patch", table: "docs", id: args.id, patch: { title: args.title } })
      }),
      "docs:remove": localMutation<{ id: string }>({
        kind: "mutation",
        name: "docs:remove",
        table: "docs",
        operationKind: "delete",
        plan: (args) => ({ kind: "delete", table: "docs", id: args.id })
      })
    }
  });
}

function roleTransport(role: number): SyncTransport {
  return {
    async push(request): Promise<PushResponse> {
      return {
        accepted: request.mutations.map((op) => ({ opId: op.opId, serverResult: { ok: true } })),
        rejected: [],
        idMaps: [],
        changes: [],
        serverTime: 1
      };
    },
    async pull(): Promise<PullResponse> {
      return { changes: [], cursors: { "byWorkspace:w1": "1" }, serverTime: 1, roles: { "byWorkspace:w1": role } };
    }
  };
}

function wrap(ui: React.ReactNode, transport: SyncTransport) {
  return (
    <ConvexProvider
      client={new ConvexReactClient("http://localhost")}
      localFirst={{ manifest: manifest(), transport, userId: "user_a", nameOf: (ref) => String(ref) }}
    >
      {ui}
    </ConvexProvider>
  );
}

afterEach(cleanup);

describe("useRole (DX v4 §6)", () => {
  function RoleView() {
    const role = useRole<number>({ workspace_id: "w1" });
    return <div data-testid="role">{role === undefined ? "loading" : role === null ? "denied" : String(role)}</div>;
  }

  it("is undefined until synced, then reactive to the pulled role", async () => {
    render(wrap(<RoleView />, roleTransport(15)));
    expect(screen.getByTestId("role").textContent).toBe("loading");
    await waitFor(() => expect(screen.getByTestId("role").textContent).toBe("15"));
  });
});

describe("useCan (DX v4 §6)", () => {
  function CanView() {
    useRole({ workspace_id: "w1" }); // drives the pull that delivers the role
    const can = useCan();
    const row = { id: "d1", workspace_id: "w1", title: "x", created_by: "user_a" };
    return <div data-testid="can">{can.patch("docs", row, { title: "y" }) ? "yes" : "no"}</div>;
  }

  it("blocks a viewer once the role syncs", async () => {
    render(wrap(<CanView />, roleTransport(10)));
    // Advisory-true before the role lands, then the mirror denies the viewer.
    await waitFor(() => expect(screen.getByTestId("can").textContent).toBe("no"));
  });

  it("allows a member once the role syncs", async () => {
    render(wrap(<CanView />, roleTransport(15)));
    await waitFor(() => expect(screen.getByTestId("can").textContent).toBe("yes"));
  });
});

describe("useUndo (DX v4 §7)", () => {
  function UndoView() {
    const create = useMutation<{ id: string; workspace_id: string; title: string }, unknown>("docs:create");
    const { undo, canUndo } = useUndo({ workspace_id: "w1" });
    return (
      <div>
        <button data-testid="edit" onClick={() => void create({ id: "d1", workspace_id: "w1", title: "next" })}>
          edit
        </button>
        <button data-testid="undo" onClick={() => void undo()}>
          undo
        </button>
        <div data-testid="canUndo">{canUndo ? "yes" : "no"}</div>
      </div>
    );
  }

  it("tracks canUndo reactively as ops are recorded and undone", async () => {
    render(wrap(<UndoView />, roleTransport(15)));
    expect(screen.getByTestId("canUndo").textContent).toBe("no");

    await act(async () => {
      screen.getByTestId("edit").click();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("canUndo").textContent).toBe("yes"));

    await act(async () => {
      screen.getByTestId("undo").click();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("canUndo").textContent).toBe("no"));
  });
});
