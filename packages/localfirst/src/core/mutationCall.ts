import type { LocalCommit, MutationStatus } from "./types.js";

export type LocalFirstMutationCall<T> = Promise<T> & {
  readonly opId: string;
  readonly local: Promise<LocalCommit>;
  readonly server: Promise<T>;
  readonly status: () => MutationStatus;
};

export function createLocalFirstMutationCall<T>(input: {
  opId: string;
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
    local: promise.then(() => ({ opId: "convex-fallback", table: "", id: "", committedAt: 0 })),
    server: promise,
    status: () => ({ opId: "convex-fallback", status: "pushing" })
  });
}
