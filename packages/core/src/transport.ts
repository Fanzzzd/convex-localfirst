import type { PullRequest, PullResponse, PushRequest, PushResponse, ServerChange } from "./types.js";

export type SyncTransport = {
  push(request: PushRequest): Promise<PushResponse>;
  pull(request: PullRequest): Promise<PullResponse>;
  /**
   * Optional reactive change feed: invoke `onChange` whenever the server has new
   * changes for `request.scopes` after `request.cursors` (true server push — no
   * polling). Returns an unsubscribe. `onChange` is a content-free doorbell: the
   * engine pulls on each fire. Transports without a reactive channel omit this and
   * the client falls back to polling (`useLiveQuery({ pollMs })`).
   */
  subscribe?(request: PullRequest, onChange: () => void): () => void;
};

/** A subscription handle from `ConvexReactClient.watchQuery`. Internal — implementation
 *  shape consumed only by createConvexTransport, not part of the public API. */
type ConvexWatch = {
  onUpdate(callback: () => void): () => void;
};

/** Minimal Convex client shape. `watchQuery` is present on ConvexReactClient (and
 *  enables reactive pull); ConvexHttpClient omits it (pull falls back to polling).
 *  Internal — not part of the public API. */
type ConvexLikeClient = {
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  query(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  watchQuery?(reference: unknown, args: Record<string, unknown>): ConvexWatch;
};

/** Server change log row shape (as returned by sync.push / sync.pull). */
type ServerStoredChange = {
  changeId: string;
  scopeKey: string;
  table: string;
  localId: string;
  kind: ServerChange["kind"];
  data?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  version: number;
  serverTime: number;
  opId?: string;
};

function toClientChange(change: ServerStoredChange): ServerChange {
  return {
    changeId: change.changeId,
    scopeKey: change.scopeKey,
    table: change.table,
    id: change.localId, // the client keys rows by localId
    kind: change.kind,
    value: change.data,
    patch: change.patch,
    version: change.version,
    serverTime: change.serverTime,
    opId: change.opId
  };
}

function scopeValue(key: string): string | undefined {
  const idx = key.indexOf(":");
  return idx >= 0 ? key.slice(idx + 1) : undefined;
}

/**
 * Adapt a Convex client + the generated sync.push/sync.pull references into the
 * engine's SyncTransport: serializes local operations, calls Convex, and maps
 * the server change log back into client ServerChange shape.
 */
export function createConvexTransport(options: {
  client: ConvexLikeClient;
  push: unknown;
  pull: unknown;
  clientId: string;
  userId: string;
}): SyncTransport {
  return {
    async push(request) {
      const response = (await options.client.mutation(options.push, {
        clientId: options.clientId,
        userId: options.userId,
        schemaVersion: request.schemaVersion,
        mutations: request.mutations.map((op) => ({
          opId: op.opId,
          clientId: op.clientId,
          schemaVersion: op.schemaVersion,
          functionName: op.functionName,
          table: op.table,
          kind: op.kind,
          localId: op.id,
          value: op.value,
          patch: op.patch,
          // The op's logical timestamp — consumed only by `timestampLww` tables on the server
          // to resolve same-field collisions by recency. Harmless extra field otherwise.
          timestamp: op.createdAt
        }))
      })) as Omit<PushResponse, "changes"> & { changes: ServerStoredChange[] };
      return { ...response, changes: response.changes.map(toClientChange) };
    },
    async pull(request) {
      const response = (await options.client.query(options.pull, {
        clientId: options.clientId,
        userId: options.userId,
        schemaVersion: request.schemaVersion,
        scopes: request.scopes.map((scope) => ({ kind: scope.kind, value: scopeValue(scope.key) })),
        cursors: request.cursors
      })) as Omit<PullResponse, "changes"> & { changes: ServerStoredChange[] };
      return { ...response, changes: response.changes.map(toClientChange) };
    },
    // Reactive pull: watch the SAME `pull` query (Convex queries are reactive) as a
    // doorbell. It re-fires whenever a new change lands in these scopes after the
    // given cursors — the engine then drains via the regular `pull` path. Reuses the
    // already-audited pull endpoint, so it adds no new server surface (no I7 change).
    // Only wired when the client is reactive (ConvexReactClient.watchQuery); the
    // HTTP client omits it and the engine falls back to polling.
    subscribe: options.client.watchQuery
      ? (request, onChange) => {
          const watch = options.client.watchQuery!(options.pull, {
            clientId: options.clientId,
            userId: options.userId,
            schemaVersion: request.schemaVersion,
            scopes: request.scopes.map((scope) => ({ kind: scope.kind, value: scopeValue(scope.key) })),
            cursors: request.cursors
          });
          return watch.onUpdate(() => onChange());
        }
      : undefined
  };
}

export class OfflineTransportError extends Error {
  constructor(message = "Local-first transport is offline") {
    super(message);
    this.name = "OfflineTransportError";
  }
}

export function createOfflineTransport(): SyncTransport {
  return {
    async push() {
      throw new OfflineTransportError();
    },
    async pull() {
      throw new OfflineTransportError();
    }
  };
}
