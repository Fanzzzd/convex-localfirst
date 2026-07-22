import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import {
  createCollaborativeDoc,
  type CompactionOptions,
  type DocStatus,
  type DocUpdateRow,
  type MutationLike,
} from "./provider.js";

/** One persisted Yjs update row, as YOUR backend stores it. The hook reads the fields
 *  named by `idField` / `docField` / `updateField` (defaults below), so a raw
 *  local-first row works without reshaping. */
export type CollaborativeDocRow = Record<string, unknown>;

export interface UseCollaborativeDocOptions {
  /** Document identity — the Y.Doc is keyed on this, and the hook applies only rows whose
   *  `docField` equals it (item 3: docId scoping is the provider's job, not the caller's).
   *  It must uniquely identify the document across every scope this hook is used in. */
  readonly docId: string;
  /** Live rows from your reactive query. Pass ALL update rows in scope — the hook filters
   *  to `docId` itself. Pass a stable reference when unchanged (a local-first `useLiveQuery`
   *  does this) so the apply effect only runs on new rows. */
  readonly updates: ReadonlyArray<CollaborativeDocRow>;
  /** Persist a local edit as a new insert-only row. Receives the base64 update; bind your
   *  docId/scope in the closure. Return the `useMutation` call (its `.local`/`.server`
   *  stages drive durability + compaction confirmation) or any promise. */
  readonly append: (updateBase64: string) => MutationLike;
  /** Delete a row subsumed by a snapshot (receives the row's `idField` value). Provide it
   *  to enable compaction; omit to disable (the log then grows unbounded, by choice). */
  readonly prune?: (rowId: string) => MutationLike;
  /** Row field carrying the stable per-row id (dedup + the value passed to `prune`).
   *  Default `"_id"`; local-first apps that key rows on `"id"` should pass that. */
  readonly idField?: string;
  /** Row field naming which document the update belongs to. Default `"doc"`. */
  readonly docField?: string;
  /** Row field holding the base64 update. Default `"update"`. */
  readonly updateField?: string;
  /** Compaction cadence, or `false` to disable. Default: on when `prune` is provided. */
  readonly compaction?: CompactionOptions | false;
  /** Legacy shorthand for `compaction.everyUpdates`. */
  readonly compactThreshold?: number;
  /** Coalesce local edits within this window into one appended row. Default 0. */
  readonly flushDebounceMs?: number;
  /** Backoff before retrying a failed append (ms). Default: 250·2^n capped at 10s. */
  readonly backoffMs?: (attempt: number) => number;
}

export interface UseCollaborativeDocResult {
  /** The live Y.Doc. Bind your editor to it (BlockNote → `doc.getXmlFragment(...)`,
   *  TipTap/y-prosemirror → a `ySyncPlugin(doc.getXmlFragment(...))`). */
  readonly doc: Y.Doc;
  /** Durability status: `{ synced, pendingUpdates, lastError, compacting }`. */
  readonly status: DocStatus;
}

/**
 * A Y.Doc whose content syncs through a local-first append-only log — now with the
 * production guarantees: durable, retried local appends (never fire-and-forget),
 * crash-safe compaction (server-confirmed snapshot before any prune), per-document row
 * scoping, and a surfaced `status`.
 *
 * ```ts
 * const updates = useLiveQuery(collection("doc_updates").scope({ workspace })) ?? [];
 * const appendRow = useMutation(api.doc_updates.append);
 * const pruneRow = useMutation(api.doc_updates.remove);
 * const { doc, status } = useCollaborativeDoc({
 *   docId, updates, idField: "id",
 *   append: (update) => appendRow({ workspace, doc: docId, update }),
 *   prune: (id) => pruneRow({ id })
 * });
 * ```
 */
export function useCollaborativeDoc(
  options: UseCollaborativeDocOptions,
): UseCollaborativeDocResult {
  const {
    docId,
    updates,
    idField = "_id",
    docField = "doc",
    updateField = "update",
    compaction,
    compactThreshold,
    flushDebounceMs,
    backoffMs,
  } = options;

  // Latest callbacks via a ref so the provider (built once per docId) always calls the
  // freshest closures without being rebuilt on every render.
  const cbs = useRef(options);
  cbs.current = options;

  const resolvedCompaction = useMemo<CompactionOptions | false | undefined>(() => {
    if (compaction === false) return false;
    if (compaction || compactThreshold !== undefined) {
      return {
        ...compaction,
        ...(compactThreshold !== undefined ? { everyUpdates: compactThreshold } : {}),
      };
    }
    return undefined;
  }, [compaction, compactThreshold]);

  // One provider per document. The persistence port reads current callbacks from the ref.
  const provider = useMemo(
    () =>
      createCollaborativeDoc(
        {
          append: (update) => cbs.current.append(update),
          prune: cbs.current.prune ? (id) => cbs.current.prune!(id) : undefined,
        },
        { docId, compaction: resolvedCompaction, flushDebounceMs, backoffMs },
      ),
    // docId identifies the document; callbacks flow through the ref. resolvedCompaction /
    // flushDebounceMs are construction-time config, captured once per doc.
    [docId],
  );
  useEffect(() => () => provider.destroy(), [provider]);

  // Map raw rows to the provider's normalized shape and feed them in. Runs on mount and
  // whenever `updates` changes; the provider dedupes and scopes to docId.
  useEffect(() => {
    const rows: DocUpdateRow[] = [];
    for (const row of updates) {
      const id = row[idField];
      const doc = row[docField];
      const update = row[updateField];
      if (typeof id === "string" && typeof doc === "string" && typeof update === "string") {
        rows.push({ id, doc, update });
      }
    }
    provider.ingestRows(rows);
  }, [provider, updates, idField, docField, updateField]);

  // Mirror provider status into React state.
  const [status, setStatus] = useState<DocStatus>(() => provider.status());
  useEffect(() => {
    setStatus(provider.status());
    return provider.subscribe(setStatus);
  }, [provider]);

  return { doc: provider.ydoc, status };
}
