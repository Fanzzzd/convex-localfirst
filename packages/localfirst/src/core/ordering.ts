import type { LocalOperation } from "./types.js";

/**
 * Total, stable order for replaying pending operations (Invariant I4).
 * Primary: creation time. Tiebreak: opId (lexicographic) so the order is
 * identical across reloads, tabs, and repeated derivations.
 */
export function compareOperations(left: LocalOperation, right: LocalOperation): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  if (left.opId < right.opId) {
    return -1;
  }
  if (left.opId > right.opId) {
    return 1;
  }
  return 0;
}

/**
 * Stable comparison for client-side query order-by (the chainable `collection`
 * builder and the declarative query interpreter). Convex orders null/undefined as
 * the smallest values; numbers compare numerically; everything
 * else compares by locale. One shared definition so the two query paths can't drift.
 */
export function compareValues(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}
