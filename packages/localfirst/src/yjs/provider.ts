import * as Y from "yjs";
import { REMOTE_ORIGIN, applyUpdateSafe, base64ToBytes, bytesToBase64, makeSnapshot } from "./yjsSync.js";

// A production Yjs provider that rides a local-first append-only log. It owns the
// full document lifecycle so an app never has to hand-roll the two subtle bugs this
// layer exists to prevent:
//
//  1. COMPACTION SAFETY — a snapshot row is written and CONFIRMED server-side before
//     any of the update rows it subsumes are pruned. A rejected snapshot prunes
//     nothing and is retried later, so history can never be lost to an only-local
//     snapshot (REVIEW §E2).
//  2. APPEND DURABILITY — local edits are buffered + retried, never fire-and-forget.
//     An append is considered done only once its `local` stage resolves (durably in
//     the local outbox); failures (quota, transient) are retried and surfaced through
//     `status.lastError` instead of silently dropping an edit (REVIEW §E6).
//
// It is framework-agnostic: it takes a small persistence port, not React or Convex.
// `useCollaborativeDoc` is a thin React binding over it.

/** One persisted Yjs update row as your backend stores it. `id` is any stable
 *  per-row identity (dedup + the argument passed to `prune`); `doc` scopes the row to
 *  one document; `update` is a base64 Yjs update (or a snapshot). */
export interface DocUpdateRow {
  readonly id: string;
  readonly doc: string;
  readonly update: string;
}

/** The two lifecycle stages a local-first write exposes. A `LocalFirstMutationCall`
 *  (from `useMutation`/`engine.mutate`) already has this shape; a plain promise counts
 *  as both stages resolving together. */
export interface MutationStages {
  /** Resolves once the write is durably persisted locally (safe across a crash/unmount). */
  readonly local?: unknown;
  /** Resolves once the server has confirmed the write. Gates compaction pruning. */
  readonly server?: unknown;
}

/** A write result the provider knows how to await: a two-stage call, or a bare
 *  promise/value treated as both stages. */
export type MutationLike = MutationStages | Promise<unknown> | unknown;

/** The port the provider needs from your backend. All three are backend-agnostic;
 *  the React binding builds them from `useLiveQuery` + `useMutation`. */
export interface DocPersistence {
  /** Optional reactive feed of ALL update rows in scope (the provider filters to its
   *  own `docId`). Return an unsubscribe. If you drive rows imperatively instead, call
   *  `ingestRows` on the returned provider and omit this. */
  readonly subscribe?: (onRows: (rows: readonly DocUpdateRow[]) => void) => () => void;
  /** Append one base64 update as a new insert-only row for this document. */
  readonly append: (update: string) => MutationLike;
  /** Delete a row subsumed by a snapshot. Omit to disable compaction (the log then
   *  grows unbounded — a deliberate choice, not a silent one). */
  readonly prune?: (id: string) => MutationLike;
}

export interface CompactionOptions {
  /** Compact once this many live rows accumulate for the document. Default 100. */
  readonly everyUpdates?: number;
  /** Compact once the live rows' combined size crosses this many bytes. Default 1 MiB. */
  readonly everyBytes?: number;
  /** Wait this long after the last change before compacting, so we snapshot a quiet
   *  document rather than mid-burst. Default 750 ms. */
  readonly debounceMs?: number;
}

export interface CreateCollaborativeDocOptions {
  /** Document identity. The provider applies only rows whose `doc` equals this. */
  readonly docId: string;
  /** Bring your own Y.Doc (e.g. one an editor already owns). Default: a fresh doc. */
  readonly doc?: Y.Doc;
  /** Passed to `new Y.Doc({ gc })` when the provider creates the doc. Default true. */
  readonly gc?: boolean;
  /** Coalesce local edits emitted within this window into ONE appended row (fewer rows,
   *  cheaper sync). Default 0 (flush on the next tick). */
  readonly flushDebounceMs?: number;
  /** Compaction cadence, or `false` to never compact. Default: on when `prune` exists. */
  readonly compaction?: CompactionOptions | false;
  /** Backoff before retrying a failed append (ms). Default: 250·2^n capped at 10s. */
  readonly backoffMs?: (attempt: number) => number;
}

export interface DocStatus {
  /** No local edits are waiting to be persisted and no compaction is in flight. */
  readonly synced: boolean;
  /** Local Yjs updates buffered or in flight, not yet durably appended. */
  readonly pendingUpdates: number;
  /** A snapshot/prune pass is running. */
  readonly compacting: boolean;
  /** The last append/compaction failure, or null. Cleared on the next success. */
  readonly lastError: Error | null;
}

export interface CollaborativeDoc {
  /** The live Y.Doc. Bind your editor to it. */
  readonly ydoc: Y.Doc;
  /** Current durability status snapshot. */
  status(): DocStatus;
  /** Subscribe to status changes; returns an unsubscribe. */
  subscribe(listener: (status: DocStatus) => void): () => void;
  /** Feed the current set of update rows (any docId; the provider filters). Use when
   *  you did not pass `persistence.subscribe`. */
  ingestRows(rows: readonly DocUpdateRow[]): void;
  /** Force-append any buffered local edits now. Resolves when they are durable. */
  flush(): Promise<void>;
  /** Run a compaction pass now (if `prune` is configured), bypassing the cadence. */
  compactNow(): Promise<void>;
  /** Stop all timers/subscriptions and (optionally) destroy the owned Y.Doc. */
  destroy(): void;
}

const DEFAULT_EVERY_UPDATES = 100;
const DEFAULT_EVERY_BYTES = 1024 * 1024;
const DEFAULT_COMPACT_DEBOUNCE = 750;
const defaultBackoff = (attempt: number) => Math.min(250 * 2 ** attempt, 10_000);

function toStages(result: MutationLike): { local: Promise<unknown>; server: Promise<unknown> } {
  if (result && typeof result === "object" && ("local" in result || "server" in result)) {
    const call = result as MutationStages;
    const server = Promise.resolve(call.server as unknown);
    const local = "local" in call ? Promise.resolve(call.local as unknown) : server;
    return { local, server };
  }
  const settled = Promise.resolve(result as unknown);
  return { local: settled, server: settled };
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Create a collaborative document over a local-first append-only log. Every Yjs
 * update is one insert-only row; the provider dedupes, applies in a deterministic
 * order, scopes to a single `docId`, durably appends local edits (with retry), and
 * compacts crash-safely (server-confirmed snapshot before any prune).
 */
export function createCollaborativeDoc(
  persistence: DocPersistence,
  options: CreateCollaborativeDocOptions
): CollaborativeDoc {
  const ownsDoc = !options.doc;
  const ydoc = options.doc ?? new Y.Doc({ gc: options.gc ?? true });
  const backoffMs = options.backoffMs ?? defaultBackoff;
  const flushDebounceMs = options.flushDebounceMs ?? 0;
  const compactionEnabled = options.compaction !== false && typeof persistence.prune === "function";
  const compaction = options.compaction === false ? undefined : options.compaction;
  const everyUpdates = compaction?.everyUpdates ?? DEFAULT_EVERY_UPDATES;
  const everyBytes = compaction?.everyBytes ?? DEFAULT_EVERY_BYTES;
  const compactDebounceMs = compaction?.debounceMs ?? DEFAULT_COMPACT_DEBOUNCE;

  // Dedup + per-row byte accounting for the rows currently folded into `ydoc`.
  const applied = new Set<string>();
  const rowBytes = new Map<string, number>();
  let liveRows: DocUpdateRow[] = []; // filtered to docId, deterministic order

  // Local-edit append buffer (coalesced) + retry state.
  let outbox: Uint8Array[] = [];
  let flushing = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  // Compaction state.
  let compacting = false;
  let compactTimer: ReturnType<typeof setTimeout> | null = null;
  let compactRun: Promise<void> = Promise.resolve();

  let lastError: Error | null = null;
  let destroyed = false;
  const listeners = new Set<(status: DocStatus) => void>();

  function currentStatus(): DocStatus {
    return {
      synced: outbox.length === 0 && !flushing && !compacting,
      pendingUpdates: outbox.length + (flushing ? 1 : 0),
      compacting,
      lastError
    };
  }
  function emit() {
    if (listeners.size === 0) return;
    const status = currentStatus();
    for (const listener of listeners) listener(status);
  }
  function setError(cause: unknown) {
    lastError = asError(cause);
    emit();
  }
  function clearError() {
    if (lastError !== null) {
      lastError = null;
      emit();
    }
  }

  // ---- applying remote/persisted rows -------------------------------------------------

  function ingestRows(rows: readonly DocUpdateRow[]) {
    if (destroyed) return;
    // Scope to THIS document (item 3: the provider filters, callers need not pre-filter)
    // and apply in a deterministic order so every mount folds rows in identically.
    const scoped = rows.filter((row) => row.doc === options.docId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    liveRows = scoped;
    let changed = false;
    for (const row of scoped) {
      if (applied.has(row.id)) continue;
      applied.add(row.id); // mark seen even on failure — a corrupt row is permanently bad
      rowBytes.set(row.id, row.update.length);
      applyUpdateSafe(ydoc, row.update, REMOTE_ORIGIN);
      changed = true;
    }
    if (changed) scheduleCompaction();
  }

  // ---- durable local appends ----------------------------------------------------------

  function onLocalUpdate(update: Uint8Array, origin: unknown) {
    if (origin === REMOTE_ORIGIN || destroyed) return; // remote-applied edits never echo back
    outbox.push(update);
    emit();
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer || retryTimer || flushing || destroyed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushDebounceMs);
  }

  async function flush(): Promise<void> {
    if (flushing || destroyed || outbox.length === 0) return;
    flushing = true;
    emit();
    // Coalesce every buffered edit into one row: applying the merge reproduces applying
    // them in sequence, so this is loss-free and simply means fewer rows.
    const batch = outbox;
    outbox = [];
    const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
    try {
      const { local, server } = toStages(persistence.append(bytesToBase64(merged)));
      // Durability is the LOCAL stage: once persisted to the outbox the engine owns the
      // server push + its retries. Surface (but don't retry) a server rejection.
      Promise.resolve(server).catch((cause) => {
        if (!destroyed) setError(cause);
      });
      await local;
      attempt = 0;
      clearError();
      flushing = false;
      emit();
      if (outbox.length > 0) scheduleFlush();
      else scheduleCompaction();
    } catch (cause) {
      // The append did not durably persist (e.g. IndexedDB quota, unmount mid-write).
      // Requeue the merged update at the FRONT and retry with backoff — never dropped.
      outbox.unshift(merged);
      flushing = false;
      setError(cause);
      const delay = backoffMs(attempt++);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void flush();
      }, delay);
    }
  }

  // ---- crash-safe compaction ----------------------------------------------------------

  function liveByteCount(): number {
    let total = 0;
    for (const value of rowBytes.values()) total += value;
    return total;
  }

  function shouldCompact(): boolean {
    if (!compactionEnabled || compacting || destroyed) return false;
    // Only compact a quiet document: no local edits pending means the rows we prune are
    // all server-known, never a still-in-flight optimistic append.
    if (outbox.length > 0 || flushing) return false;
    return liveRows.length >= everyUpdates || liveByteCount() >= everyBytes;
  }

  function scheduleCompaction() {
    if (!shouldCompact() || compactTimer) return;
    compactTimer = setTimeout(() => {
      compactTimer = null;
      if (shouldCompact()) void compactNow();
    }, compactDebounceMs);
  }

  function compactNow(): Promise<void> {
    if (compacting || destroyed || !compactionEnabled) return compactRun;
    compactRun = runCompaction();
    return compactRun;
  }

  async function runCompaction(): Promise<void> {
    const prune = persistence.prune;
    if (!prune) return;
    compacting = true;
    emit();
    // Snapshot exactly the rows we intend to prune. Rows that arrive AFTER this point are
    // not in `subsumed`, so a concurrent edit is never pruned and never lost.
    const subsumed = liveRows.map((row) => row.id);
    const snapshot = makeSnapshot(ydoc);
    try {
      // 1) Write the snapshot and WAIT for server confirmation. This is the §E2 fix: no
      //    prune may run until the snapshot that preserves this history is durable
      //    server-side. A rejection throws here → we prune nothing and retry later.
      await toStages(persistence.append(snapshot)).server;
      if (destroyed) return;
      // 2) Only now delete the subsumed rows. Crash between 1 and 2 just leaves redundant
      //    rows (pruned on the next pass), never lost history.
      const results = await Promise.allSettled(subsumed.map((id) => Promise.resolve(toStages(prune(id)).server)));
      const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      for (const id of subsumed) {
        // Drop dedup/byte accounting so cadence resets; a re-delivered pruned row is a
        // no-op apply anyway. The snapshot row itself re-enters via the next ingest.
        applied.delete(id);
        rowBytes.delete(id);
      }
      liveRows = liveRows.filter((row) => !subsumed.includes(row.id));
      if (failed) setError(failed.reason);
      else clearError();
    } catch (cause) {
      setError(cause); // snapshot not confirmed — history preserved, nothing pruned
    } finally {
      compacting = false;
      emit();
    }
  }

  // ---- wiring / teardown --------------------------------------------------------------

  ydoc.on("update", onLocalUpdate);
  const unsubscribe = persistence.subscribe?.((rows) => ingestRows(rows));

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    ydoc.off("update", onLocalUpdate);
    unsubscribe?.();
    if (flushTimer) clearTimeout(flushTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (compactTimer) clearTimeout(compactTimer);
    // Best-effort final flush of durable local edits — their `local` stage may still land
    // even after we stop tracking; if it cannot, the edits were already surfaced as
    // pending and replay from the log on the next mount once persisted.
    if (outbox.length > 0) {
      const merged = outbox.length === 1 ? outbox[0]! : Y.mergeUpdates(outbox);
      outbox = [];
      try {
        void toStages(persistence.append(bytesToBase64(merged)));
      } catch {
        /* nothing durable we can do at teardown */
      }
    }
    listeners.clear();
    if (ownsDoc) ydoc.destroy();
  }

  return {
    ydoc,
    status: currentStatus,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ingestRows,
    async flush() {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await flush();
    },
    compactNow,
    destroy
  };
}

/** Re-exported so tests/consumers can round-trip rows without importing the codec path. */
export { base64ToBytes, bytesToBase64 };
