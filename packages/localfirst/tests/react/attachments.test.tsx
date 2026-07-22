import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  MemoryLocalStore,
  byUser,
  defineLocalFirstManifest,
  localMutation,
  localTable,
  type AttachmentBackend,
  type LocalFirstManifest,
  type PushResponse,
  type SyncTransport
} from "../../src/core/index.js";

// Minimal convex/react stub (local-first never touches it here).
vi.mock("convex/react", () => ({
  ConvexReactClient: class {},
  ConvexProvider: ({ children }: { children: React.ReactNode }) => children,
  Authenticated: ({ children }: { children: React.ReactNode }) => children,
  Unauthenticated: () => null,
  AuthLoading: () => null,
  useConvex: () => null,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
  useQuery: () => undefined,
  useMutation: () => async () => undefined
}));

const { ConvexProvider, ConvexReactClient, useCreateAttachment, useAttachmentUpload, useSyncRecovery } = await import(
  "../../src/react/index"
);
const client = new ConvexReactClient("http://localhost");

function manifest(): LocalFirstManifest {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      attachments: localTable({ table: "attachments", idField: "localId", scope: byUser("ownerId"), indexes: {} })
    },
    queries: {},
    mutations: {
      "attachments:create": localMutation<{ localId?: string; name: string }>({
        kind: "mutation",
        name: "attachments:create",
        table: "attachments",
        plan: (args, ctx) => ({
          kind: "insert",
          table: "attachments",
          id: args.localId ?? ctx.localId("attachments"),
          value: { ownerId: "user_a", name: args.name, storageId: null }
        })
      })
    }
  });
}

const acceptAll: SyncTransport = {
  async push(request): Promise<PushResponse> {
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

function makeBackend(opts: { fail?: boolean; gate?: Promise<void> }): AttachmentBackend {
  return {
    async getUploadUrl(input) {
      return `https://upload.test/${input.localId}`;
    },
    async upload({ onProgress }) {
      onProgress(0.5);
      if (opts.gate) await opts.gate;
      onProgress(1);
      return { storageId: "storage_react" };
    },
    async finalize() {
      if (opts.fail) throw new Error("finalize denied");
    }
  };
}

function Harness({ localIdRef }: { localIdRef: { current: string | null } }) {
  const create = useCreateAttachment("attachments:create" as never);
  const [localId, setLocalId] = React.useState<string | null>(null);
  const upload = useAttachmentUpload(localId);
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          void create({ metadata: { name: "f.txt" }, blob: new Blob(["x"], { type: "text/plain" }) }).then((r) => {
            localIdRef.current = r.localId;
            setLocalId(r.localId);
          })
        }
      >
        add
      </button>
      <span data-testid="state">{upload.state}</span>
      <span data-testid="progress">{upload.progress ?? -1}</span>
    </div>
  );
}

function RecoveryProbe() {
  const recovery = useSyncRecovery();
  return <span data-testid="failed">{recovery.failedAttachments.length}</span>;
}

afterEach(() => cleanup());

describe("useCreateAttachment / useAttachmentUpload", () => {
  it("uploads and drives the hook to done, surfacing progress", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const backend = makeBackend({ gate });
    const localIdRef = { current: null as string | null };

    render(
      <ConvexProvider
        client={client}
        localFirst={{
          manifest: manifest(),
          transport: acceptAll,
          store: new MemoryLocalStore(),
          userId: "user_a",
          nameOf: (r) => String(r),
          attachments: { backend }
        }}
      >
        <Harness localIdRef={localIdRef} />
      </ConvexProvider>
    );

    await act(async () => {
      screen.getByText("add").click();
      await new Promise((r) => setTimeout(r, 0));
    });

    // Progress reaches the hook while the upload is gated mid-flight.
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("uploading"));
    await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("0.5"));

    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("done"));
  });

  it("surfaces an upload failure through useSyncRecovery", async () => {
    const backend = makeBackend({ fail: true });
    const localIdRef = { current: null as string | null };

    render(
      <ConvexProvider
        client={client}
        localFirst={{
          manifest: manifest(),
          transport: acceptAll,
          store: new MemoryLocalStore(),
          userId: "user_a",
          nameOf: (r) => String(r),
          attachments: { backend },
          // Fast retry so exhaustion is quick.
        }}
      >
        <Harness localIdRef={localIdRef} />
        <RecoveryProbe />
      </ConvexProvider>
    );

    await act(async () => {
      screen.getByText("add").click();
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("failed"), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId("failed").textContent).toBe("1"));
  });
});
