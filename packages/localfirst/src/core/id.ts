import type { TableName } from "./types.js";

export type IdFactory = (table: TableName) => string;

export function createDefaultIdFactory(prefix = "lf"): IdFactory {
  let counter = 0;
  return (table: TableName) => {
    counter += 1;
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${table}_${Date.now().toString(36)}_${counter.toString(36)}_${random}`;
  };
}

export function createClientId(): string {
  const random = Math.random().toString(36).slice(2, 14);
  return `client_${Date.now().toString(36)}_${random}`;
}

let opCounter = 0;

export function createOpId(clientId: string): string {
  // Zero-padded monotonic counter so lexicographic opId order matches creation
  // order — this is the deterministic tiebreak when two ops share a createdAt
  // (Invariant I4). Time component keeps ids sortable across process restarts.
  opCounter += 1;
  const seq = opCounter.toString(36).padStart(8, "0");
  const random = Math.random().toString(36).slice(2, 10);
  return `op_${clientId}_${Date.now().toString(36)}_${seq}_${random}`;
}
