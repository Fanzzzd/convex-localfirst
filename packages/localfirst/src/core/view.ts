import { compareOperations } from "./ordering.js";
import { rebaseAndReplay } from "./rebase.js";
import type { LocalOperation, OperationStatus, RowValue, ServerChange, TableName } from "./types.js";

/** Ops whose effect is not yet folded into canonical, so they must be replayed. */
const REPLAYED_STATUSES: ReadonlySet<OperationStatus> = new Set(["pending", "pushing", "acked"]);

/**
 * Derive the live view for one table (Invariant I1): canonical snapshot with the
 * deterministically-ordered pending operations replayed on top. Shared by every
 * LocalStore implementation so the rebase logic lives in exactly one place.
 */
export function deriveView(
  table: TableName,
  canonicalRows: readonly RowValue[],
  operations: readonly LocalOperation[]
): RowValue[] {
  const ops = operations.filter((operation) => operation.table === table);
  const replayed = ops.filter((operation) => REPLAYED_STATUSES.has(operation.status)).sort(compareOperations);

  const { rows, conflicts } = rebaseAndReplay({
    canonicalRows,
    serverChanges: [],
    pendingOperations: replayed
  });

  const byId = new Map<string, RowValue>(rows.map((row) => [row._id, row]));

  // Replay failures (e.g. patch over a missing row) surface as row conflicts.
  for (const conflict of conflicts) {
    const op = ops.find((operation) => operation.opId === conflict.opId);
    const row = op ? byId.get(op.id) : undefined;
    if (row) {
      row._conflict = { kind: "mergeFailed", message: conflict.message, opId: conflict.opId };
    }
  }

  // Server rejections surface on the (now reverted) canonical row. A rejected
  // INSERT has no canonical row to annotate — the optimistic row correctly
  // reverts (the insert never happened); the rejection is still observable via
  // the op's "rejected" status and status.lastError. ponytail: surfacing a
  // dismissable "ghost" row for a rejected insert is a deferred UX enhancement.
  for (const op of ops) {
    if (op.status !== "rejected") {
      continue;
    }
    const row = byId.get(op.id);
    if (row) {
      row._conflict = { kind: "serverRejected", message: op.error ?? "Server rejected the operation", opId: op.opId };
    }
  }

  return Array.from(byId.values());
}

/**
 * Compute the next canonical row for a server change, or "stale" if the change
 * must be ignored because its version does not advance the row (Invariant I5).
 */
export function nextCanonicalRow(current: RowValue | null, change: ServerChange): RowValue | "stale" {
  if (current && typeof current._version === "number" && change.version <= current._version) {
    return "stale";
  }
  if (change.kind === "delete") {
    const base = current ?? { _id: change.id, _table: change.table };
    return { ...base, _id: change.id, _table: change.table, _deleted: true, _version: change.version };
  }
  if (change.kind === "patch") {
    const base = current ?? { _id: change.id, _table: change.table };
    return {
      ...base,
      ...(change.patch ?? {}),
      _id: change.id,
      _table: change.table,
      _version: change.version,
      _deleted: false
    };
  }
  // insert | replace: the canonical row becomes exactly the server value.
  return {
    ...(change.value ?? {}),
    _id: change.id,
    _table: change.table,
    _version: change.version,
    _deleted: false
  };
}
