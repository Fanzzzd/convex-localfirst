import {
  MemoryLocalStore,
  byUser,
  defineLocalFirstManifest,
  fieldLww,
  localMutation,
  localQuery,
  localTable,
  type LocalFirstManifest,
  type PushResponse,
  type RowValue,
  type ServerChange,
  type SyncTransport
} from "../src";
import { LocalFirstEngine } from "../src/internal";

export function createTodoManifest(): LocalFirstManifest {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      todos: localTable({
        table: "todos",
        idField: "localId",
        scope: byUser("ownerId"),
        conflict: fieldLww(),
        indexes: { byList: ["ownerId", "listId", "createdAt"] }
      })
    },
    queries: {
      "todos:list": localQuery<{ listId: string }, readonly RowValue[]>({
        kind: "query",
        name: "todos:list",
        table: "todos",
        initial: [],
        run(rows, args) {
          return rows.filter((row) => row.listId === args.listId);
        }
      })
    },
    mutations: {
      "todos:create": localMutation<{ localId?: string; listId: string; text: string }>({
        kind: "mutation",
        name: "todos:create",
        table: "todos",
        plan(args, ctx) {
          return {
            kind: "insert",
            table: "todos",
            id: args.localId ?? ctx.localId("todos"),
            value: {
              ownerId: ctx.userId ?? "anon",
              listId: args.listId,
              text: args.text,
              done: false,
              createdAt: ctx.now,
              updatedAt: ctx.now
            }
          };
        }
      }),
      "todos:toggle": localMutation<{ id: string; done: boolean }>({
        kind: "mutation",
        name: "todos:toggle",
        table: "todos",
        plan(args) {
          return { kind: "patch", table: "todos", id: args.id, patch: { done: args.done } };
        }
      }),
      "todos:remove": localMutation<{ id: string }>({
        kind: "mutation",
        name: "todos:remove",
        table: "todos",
        plan(args) {
          return { kind: "delete", table: "todos", id: args.id };
        }
      })
    }
  });
}

export type Harness = {
  readonly store: MemoryLocalStore;
  readonly engine: LocalFirstEngine;
  /** Monotonic logical clock; each read advances it so createdAt values are unique. */
  tick(): number;
};

export function createHarness(
  options: {
    store?: MemoryLocalStore;
    transport?: SyncTransport;
    retry?: { retries: number; baseDelayMs: number };
    sleep?: (ms: number) => Promise<void>;
    clock?: () => number;
  } = {}
): Harness {
  const store = options.store ?? new MemoryLocalStore();
  let now = 1000;
  let ids = 0;
  const engine = new LocalFirstEngine({
    manifest: createTodoManifest(),
    store,
    clientId: "client_test",
    userId: "user_a",
    transport: options.transport,
    nameOf: (reference) => String(reference),
    idFactory: () => `todos_local_${++ids}`,
    clock: options.clock ?? (() => now++),
    retry: options.retry,
    sleep: options.sleep ?? (() => Promise.resolve())
  });
  return { store, engine, tick: () => now++ };
}

/** Push transport that accepts everything and optionally echoes server changes. */
export function acceptAllTransport(changesFor?: (opId: string) => readonly ServerChange[]): SyncTransport {
  return {
    async push(request): Promise<PushResponse> {
      const changes = request.mutations.flatMap((op) => changesFor?.(op.opId) ?? []);
      return {
        accepted: request.mutations.map((op) => ({ opId: op.opId, serverResult: { ok: true, id: op.id } })),
        rejected: [],
        idMaps: [],
        changes,
        serverTime: 1
      };
    },
    async pull() {
      return { changes: [], cursors: {}, serverTime: 1 };
    }
  };
}

/** Push transport that rejects every op with the given message. */
export function rejectingTransport(message: string): SyncTransport {
  return {
    async push(request): Promise<PushResponse> {
      return {
        accepted: [],
        rejected: request.mutations.map((op) => ({ opId: op.opId, message })),
        idMaps: [],
        changes: [],
        serverTime: 1
      };
    },
    async pull() {
      return { changes: [], cursors: {}, serverTime: 1 };
    }
  };
}

/** Offline: push never settles (no ack, no rejection), so call.server stays pending. */
export function offlineTransport(): SyncTransport {
  return {
    push: () => new Promise<PushResponse>(() => {}),
    pull: () => new Promise(() => {})
  };
}

export function serverChange(input: Partial<ServerChange> & Pick<ServerChange, "id" | "kind" | "version">): ServerChange {
  return {
    changeId: input.changeId ?? `chg_${input.id}_${input.version}`,
    scopeKey: input.scopeKey ?? "user:user_a",
    table: input.table ?? "todos",
    id: input.id,
    kind: input.kind,
    value: input.value,
    patch: input.patch,
    version: input.version,
    serverTime: input.serverTime ?? input.version,
    opId: input.opId
  };
}
