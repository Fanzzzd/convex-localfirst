import * as React from "react";
import * as ConvexReact from "convex/react";
import {
  MemoryLocalStore,
  collectManifest,
  createConvexTransport,
  createLocalDb,
  createLocalFirstEngine,
  type LocalDb,
  type LocalFirstEngine,
  type LocalFirstManifest,
  type SyncScope,
  type SyncTransport
} from "../core/index.js";
import { LF_METADATA_KEY } from "../core/internal.js";
import { LocalFirstEngineProvider, convexFunctionName } from "../react/index.js";
import { collectTables } from "../server/index.js";
import {
  applyServerWrite,
  handlePull,
  handlePush,
  type LedgerEntry,
  type PullInput,
  type PushInput,
  type SyncConfig
} from "../server/serverSync.js";
import { MemoryServerStore } from "./memoryServer.js";

export { MemoryServerStore };

/** Per-table server-minted fields for the harness — mirrors `createSyncFunctions({ serverStamp })`
 *  but with a pure stamp (no Convex `ctx`). `fields` are rejected from client writes; `stamp`
 *  mints them on insert. */
export type TestHarnessServerStamp = Record<
  string,
  {
    readonly fields: readonly string[];
    readonly stamp: (input: {
      userId: string;
      value: Record<string, unknown>;
    }) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  }
>;

export type CreateTestHarnessOptions<Modules extends Record<string, unknown>> = {
  /** Your imported `lf.table` modules — the SAME isomorphic modules the app and server use.
   *  The client manifest (collectManifest) and the server config (collectTables) are both
   *  derived from them, so the harness runs the exact declarations the app deploys. */
  readonly modules: Modules;
  readonly schemaVersion?: number;
  /** Server access rules (membership/read/write), serverSync shape — `member(input, store)`,
   *  `read(input)`, `write(input)`. Required if any table uses a workspace/project scope. */
  readonly access?: SyncConfig["access"];
  readonly onWrite?: SyncConfig["onWrite"];
  readonly serverStamp?: TestHarnessServerStamp;
  /** The authenticated user for the initial engine. Switch it later with `setUser`. */
  readonly userId?: string | null;
  readonly clientId?: string;
  /** Starting logical clock in ms (default 1_000_000). Threaded into engine timestamps AND
   *  the server's serverTime, so tests are fully deterministic. */
  readonly now?: number;
};

export type TestHarness<Modules extends Record<string, unknown>> = {
  /** Fully-typed local db root (`createLocalDb`) — `db.issues.scope({...})` etc. */
  readonly db: LocalDb<Modules>;
  /** The current client engine (swaps on `setUser`). Handy for status assertions. */
  readonly engine: LocalFirstEngine;
  /** React wrapper that publishes the current engine to the local-first hooks. Requires
   *  `react` to be installed (same optional-peer posture as the react entry). */
  readonly Provider: (props: { children?: React.ReactNode }) => React.ReactElement;
  readonly server: {
    /** Insert authoritative rows (via the trusted server writer) so clients pull them. Each
     *  row must carry its scope field (owner/workspace) and, ideally, its id field. */
    seed(table: string, rows: readonly Record<string, unknown>[]): Promise<void>;
    /** Current authoritative rows for a table. */
    rows(table: string): Record<string, unknown>[];
    /** Every recorded operation-ledger entry. */
    ledger(): LedgerEntry[];
    /** The underlying in-memory store (advanced: gc(), members, denyWrite, changes). */
    readonly store: MemoryServerStore;
  };
  /** Cut the network: pushes/pulls reject until `goOnline()`. Local reads/writes still work. */
  goOffline(): void;
  /** Restore the network and kick a flush of the outbox. Follow with `await settled()`. */
  goOnline(): void;
  /** Await sync quiescence: drain the outbox and pull every known scope until stable. */
  settled(): Promise<void>;
  /** Deterministic clock threaded into the engine and server. */
  readonly clock: { now(): number; advance(ms: number): void };
  /** Switch the authenticated user — rebuilds the engine on a fresh local store (device
   *  isolation, I9) and re-renders the Provider. */
  setUser(userId: string | null): void;
  /** The current authenticated user. */
  userId(): string | null;
  /** Tear down the current engine (call in test cleanup). */
  dispose(): void;
};

const microtask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Package the internal test machinery for app developers (DX v4 §9). Returns a fully wired,
 * deterministic local-first environment: a memory store + a fake in-process server built on
 * the REAL `handlePush`/`handlePull`, bridged through the REAL `createConvexTransport` and a
 * controllable transport, driving a REAL engine. Test "offline edit → conflict → recovery" in
 * ~10 lines with the public hooks — the same code paths the library ships.
 *
 * ```ts
 * const t = createTestHarness({ modules: { todos } });
 * t.server.seed("todos", [{ localId: "a", ownerId: "u1", text: "hi", done: false }]);
 * const { result } = renderHook(() => useLiveQuery(t.db.todos.scope({})), { wrapper: t.Provider });
 * await t.goOffline(); // ...mutate... await t.goOnline(); await t.settled();
 * ```
 */
export function createTestHarness<Modules extends Record<string, unknown>>(
  options: CreateTestHarnessOptions<Modules>
): TestHarness<Modules> {
  const { modules } = options;
  const manifest: LocalFirstManifest = collectManifest(modules, { schemaVersion: options.schemaVersion });
  const schemaVersion = manifest.schemaVersion;

  // --- Server config (derived from the SAME modules) --------------------------
  const serverStore = new MemoryServerStore();
  const serverTables = collectTables(modules);
  const tables = { ...serverTables };
  for (const [table, stamp] of Object.entries(options.serverStamp ?? {})) {
    const base = tables[table];
    if (!base) throw new Error(`createTestHarness: serverStamp names unknown local-first table "${table}"`);
    tables[table] = {
      ...base,
      serverOnlyFields: [...new Set(stamp.fields)],
      serverStamp: (input) => stamp.stamp(input)
    };
  }
  let now = options.now ?? 1_000_000;
  const config: SyncConfig = {
    schemaVersion,
    tables,
    now: () => now,
    access: options.access,
    onWrite: options.onWrite
  };

  // --- Deterministic id factory (globally unique across engines) --------------
  let idSeq = 0;
  const serverIdFactory = () => `srvgen_${++idSeq}`;

  // --- Name resolver ----------------------------------------------------------
  // Consumers pass Convex function references (`api.todos.create` / `anyApi.todos.create`) to
  // useQuery/useMutation, resolved by Convex's getFunctionName exactly as in a real app
  // (convexFunctionName). As a convenience for headless `engine.mutate(module.create, …)`,
  // the imported lf.table stubs also resolve directly to their "moduleKey:exportName".
  const nameByRef = new Map<unknown, string>();
  for (const [moduleKey, mod] of Object.entries(modules)) {
    if (!mod || (typeof mod !== "object" && typeof mod !== "function")) continue;
    for (const [exportName, exported] of Object.entries(mod as Record<string, unknown>)) {
      if (exported && (typeof exported === "object" || typeof exported === "function")) {
        if ((exported as Record<string, unknown>)[LF_METADATA_KEY]) {
          nameByRef.set(exported, `${moduleKey}:${exportName}`);
        }
      }
    }
  }
  const nameOf = (reference: unknown) => nameByRef.get(reference) ?? convexFunctionName(reference);

  // --- Network gate + transport (bridged to the real handlers) ----------------
  let online = true;
  const makeTransport = (uid: string, clientId: string): SyncTransport => {
    const client = {
      mutation: async (_ref: unknown, args: Record<string, unknown>) =>
        handlePush(serverStore, config, args as unknown as PushInput),
      query: async (_ref: unknown, args: Record<string, unknown>) =>
        handlePull(serverStore, config, { ...args, cursors: args.cursors ?? {} } as unknown as PullInput)
    };
    const real = createConvexTransport({ client, push: "PUSH", pull: "PULL", clientId, userId: uid });
    return {
      push: (request) => (online ? real.push(request) : Promise.reject(new Error("offline"))),
      pull: (request) => (online ? real.pull(request) : Promise.reject(new Error("offline")))
    };
  };

  // --- Engine (rebuilt on setUser) --------------------------------------------
  const baseClientId = options.clientId ?? "test_client";
  let currentUserId: string | null = options.userId ?? null;
  const engineListeners = new Set<() => void>();

  const buildEngine = (uid: string | null): LocalFirstEngine => {
    const clientId = `${baseClientId}_${uid ?? "anon"}`;
    return createLocalFirstEngine({
      manifest,
      store: new MemoryLocalStore(),
      clientId,
      userId: uid,
      transport: makeTransport(uid ?? "", clientId),
      nameOf,
      idFactory: (table) => `${table}_${uid ?? "anon"}_${++idSeq}`,
      clock: () => now,
      sleep: async () => {},
      syncTimeoutMs: 0
    });
  };

  let engine = buildEngine(currentUserId);

  // The public useQuery/useMutation hooks read Convex's client context (they fall through to
  // Convex for non-local functions). Provide an INERT client — it never connects because
  // every local-first query is fed "skip" and every local mutation runs on the engine, so
  // no Convex query/mutation is ever issued.
  const convexClient = new ConvexReact.ConvexReactClient("https://convex-localfirst-harness.local");

  const knownScopes = (): SyncScope[] => {
    const keys = new Set<string>();
    if (currentUserId != null) keys.add(`u:${currentUserId}`);
    // Membership scopes the server has data in (a byUser key for another user would just
    // resolve back to this identity, so only include the current user's own).
    for (const change of serverStore.changes) if (!change.scopeKey.startsWith("u:")) keys.add(change.scopeKey);
    return [...keys].map((key) => ({
      kind: (key.startsWith("u:") ? "byUser" : key.slice(0, key.indexOf(":"))) as SyncScope["kind"],
      key
    }));
  };

  const harness: TestHarness<Modules> = {
    db: createLocalDb(modules),
    get engine() {
      return engine;
    },
    Provider: ({ children }: { children?: React.ReactNode }) => {
      const active = React.useSyncExternalStore(
        (cb) => {
          engineListeners.add(cb);
          return () => engineListeners.delete(cb);
        },
        () => engine,
        () => engine
      );
      return React.createElement(
        ConvexReact.ConvexProvider,
        { client: convexClient },
        React.createElement(LocalFirstEngineProvider, { engine: active, userId: currentUserId, children })
      );
    },
    server: {
      async seed(table, rows) {
        const idField = config.tables[table]?.idField ?? "localId";
        for (const row of rows) {
          const localId = row[idField] != null ? String(row[idField]) : undefined;
          await applyServerWrite(serverStore, config, { kind: "insert", table, value: { ...row }, localId }, serverIdFactory);
        }
      },
      rows(table) {
        return [...(serverStore.rows.get(table)?.values() ?? [])];
      },
      ledger() {
        return [...serverStore.ledger.values()];
      },
      store: serverStore
    },
    goOffline() {
      online = false;
      engine.setOnline(false);
    },
    goOnline() {
      online = true;
      engine.setOnline(true);
      engine.flushPending();
    },
    async settled() {
      if (!online) return;
      for (let round = 0; round < 30; round++) {
        await microtask();
        await engine.syncOnce(knownScopes());
        await microtask();
        const status = engine.getStatus();
        if (status.pendingMutations === 0 && !status.syncing) break;
      }
    },
    clock: {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      }
    },
    setUser(uid) {
      engine.dispose();
      currentUserId = uid;
      engine = buildEngine(uid);
      for (const listener of Array.from(engineListeners)) listener();
    },
    userId: () => currentUserId,
    dispose() {
      engine.dispose();
      void convexClient.close();
    }
  };

  return harness;
}
