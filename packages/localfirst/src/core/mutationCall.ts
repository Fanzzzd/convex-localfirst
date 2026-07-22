import type { LocalCommit, LocalId, MutationStatus } from "./types.js";

export type LocalFirstMutationCall<T> = Promise<T> & {
  readonly opId: string;
  /**
   * The CANONICAL row id this mutation targets, available SYNCHRONOUSLY (before any
   * await) — the new row's id for an insert, the edited/removed row's id otherwise. It
   * equals `(await .local).id`, `row[idField]`, and `row._id` on every later read. The
   * insert-then-patch-same-row seam for `engine.batch`: `const { id } = create({...});
   * update({ id, ... })` inside one batch works because `id` is known at call time.
   */
  readonly id: LocalId;
  readonly local: Promise<LocalCommit>;
  readonly server: Promise<T>;
  readonly status: () => MutationStatus;
};

export function createLocalFirstMutationCall<T>(input: {
  opId: string;
  id: LocalId;
  local: Promise<LocalCommit>;
  server: Promise<T>;
  status: () => MutationStatus;
}): LocalFirstMutationCall<T> {
  const promise = input.server as LocalFirstMutationCall<T>;
  Object.defineProperties(promise, {
    opId: {
      enumerable: true,
      configurable: false,
      value: input.opId
    },
    id: {
      enumerable: true,
      configurable: false,
      value: input.id
    },
    local: {
      enumerable: true,
      configurable: false,
      value: input.local
    },
    server: {
      enumerable: true,
      configurable: false,
      value: input.server
    },
    status: {
      enumerable: false,
      configurable: false,
      value: input.status
    }
  });
  return promise;
}

/**
 * Wrap a plain Convex mutation promise in the hybrid-call shape so useMutation
 * has ONE return type. await behaves exactly like Convex (resolves to the server
 * result); .local resolves immediately (nothing is stored locally for fallback);
 * .server is the Convex promise. Fallback never breaks existing Convex code.
 */
export function createFallbackMutationCall<T>(promise: Promise<T>): LocalFirstMutationCall<T> {
  return createLocalFirstMutationCall<T>({
    opId: "convex-fallback",
    id: "",
    local: promise.then(() => ({ opId: "convex-fallback", table: "", id: "", committedAt: 0 })),
    server: promise,
    status: () => ({ opId: "convex-fallback", status: "pushing" })
  });
}

/**
 * The handle `engine.batch(fn)` / `useBatch()` returns — a group of local-first
 * mutations that land or reject on the server as ONE atomic unit (DX v4 §5).
 *
 *  - `.local` resolves once EVERY op in the group is durably enqueued and locally
 *    applied (optimistically, in order). This is what you usually await.
 *  - `.server` resolves with the per-op server results when the whole group is
 *    accepted, or REJECTS with the group's rejection reason (and every optimistic op
 *    reverts as a unit). Awaiting the handle itself is the same as `.server`.
 *  - `.groupId` is the shared id of the group's member operations.
 *
 * A group is all-or-nothing: a mid-group authorization failure writes zero server
 * side effects and reverts the entire group client-side.
 */
export type LocalFirstBatchCall<T = unknown> = Promise<readonly T[]> & {
  readonly groupId: string;
  readonly local: Promise<readonly LocalCommit[]>;
  readonly server: Promise<readonly T[]>;
};

export function createLocalFirstBatchCall<T = unknown>(input: {
  groupId: string;
  local: Promise<readonly LocalCommit[]>;
  server: Promise<readonly T[]>;
}): LocalFirstBatchCall<T> {
  const promise = input.server as LocalFirstBatchCall<T>;
  Object.defineProperties(promise, {
    groupId: { enumerable: true, configurable: false, value: input.groupId },
    local: { enumerable: true, configurable: false, value: input.local },
    server: { enumerable: true, configurable: false, value: input.server }
  });
  return promise;
}
