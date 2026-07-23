import { mergePatch } from "./setMerge.js";
import type { LocalOperation, RowValue, ServerChange } from "./types.js";

export type RebaseInput = {
  readonly canonicalRows: readonly RowValue[];
  readonly serverChanges: readonly ServerChange[];
  readonly pendingOperations: readonly LocalOperation[];
};

export type RebaseOutput = {
  readonly rows: readonly RowValue[];
  readonly conflicts: readonly { opId: string; message: string }[];
};

export function rebaseAndReplay(input: RebaseInput): RebaseOutput {
  const rows = new Map<string, RowValue>();
  const conflicts: { opId: string; message: string }[] = [];

  for (const row of input.canonicalRows) {
    rows.set(`${row._table ?? ""}:${row._id}`, { ...row });
  }

  for (const change of input.serverChanges) {
    const key = `${change.table}:${change.id}`;
    if (change.kind === "delete") {
      const current = rows.get(key) ?? { _id: change.id, _table: change.table };
      rows.set(key, { ...current, _deleted: true, _version: change.version });
      continue;
    }
    const current = rows.get(key) ?? { _id: change.id, _table: change.table };
    // Server patches are pre-materialized (the server resolves set/counter deltas before
    // appending), so this matches a plain spread today — but routing through mergePatch (the
    // one shared apply rule, same as the pending-op path below) makes server changes delta-safe
    // by construction, so a re-delivered or future delta-bearing change can never clobber.
    const next =
      change.kind === "patch"
        ? mergePatch(current, change.patch ?? {})
        : { ...current, ...change.value };
    rows.set(key, {
      ...next,
      _id: change.id,
      _table: change.table,
      _version: change.version,
      _deleted: false,
    });
  }

  for (const operation of input.pendingOperations) {
    const key = `${operation.table}:${operation.id}`;
    const current = rows.get(key);
    if (operation.kind === "insert") {
      rows.set(key, {
        ...operation.value,
        _id: operation.id,
        _table: operation.table,
        _pending: true,
        _deleted: false,
      });
      continue;
    }
    if (operation.kind === "patch") {
      if (!current || current._deleted) {
        conflicts.push({ opId: operation.opId, message: "Cannot replay patch over a missing row" });
        continue;
      }
      // mergePatch set-merges any SetDelta field (declared set fields, computed at commit)
      // and LWW-overwrites the rest — so a pending set-field add replays as a merge over
      // the current value, not a clobber. For plain patches it's identical to a spread.
      rows.set(key, { ...mergePatch(current, operation.patch ?? {}), _pending: true });
      continue;
    }
    if (!current) {
      conflicts.push({ opId: operation.opId, message: "Cannot replay delete over a missing row" });
      continue;
    }
    rows.set(key, { ...current, _deleted: true, _pending: true });
  }

  return { rows: Array.from(rows.values()), conflicts };
}
