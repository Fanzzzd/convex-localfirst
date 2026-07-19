import { useEffect, useMemo, useRef } from "react";
import * as Y from "yjs";
import { REMOTE_ORIGIN, applyUpdateSafe, bytesToBase64, makeSnapshot } from "./yjsSync.js";

/** One persisted Yjs update row, as your backend stores it. `_id` is any stable
 *  per-row identity (used to dedupe applied rows); `update` is a base64 update. */
export interface CollaborativeDocRow {
  readonly _id: string;
  readonly update: string;
}

export interface UseCollaborativeDocOptions {
  /** Document identity — the Y.Doc is keyed on this alone, so it must uniquely identify the
   *  document across EVERY scope this hook is used in. If your ids are only unique per
   *  workspace/project, pass a composite (e.g. `` `${workspaceId}:${docId}` ``) or the doc
   *  could merge rows across scopes. Changing it rebuilds the Y.Doc; also pass `key={docId}`
   *  to the editor component so it remounts. */
  readonly docId: string;
  /** Live rows for THIS document, from your own reactive query. The hook applies EVERY row you
   *  pass — it has no docId field to filter on — so scope/`.where` your query to exactly this
   *  document; a stray row from another doc would merge into this Y.Doc. Pass a stable reference
   *  when unchanged (a local-first `useLiveQuery` does this) so the apply effect only fires on new rows. */
  readonly updates: ReadonlyArray<CollaborativeDocRow>;
  /** Persist a local edit as a new insert-only row. Receives the base64 update;
   *  bind your docId/scope in the closure. May return a promise (awaited during compaction). */
  readonly append: (updateBase64: string) => unknown;
  /** Delete a row subsumed by a snapshot. Provide it to enable compaction; omit to disable —
   *  then both the row log AND the in-memory applied-set grow unbounded over the doc's lifetime.
   *  May return a promise. */
  readonly prune?: (rowId: string) => unknown;
  /** Compact once the row count crosses this many (default 50). No effect without `prune`. */
  readonly compactThreshold?: number;
}

/**
 * A Y.Doc whose content syncs through a local-first append-only log: every Yjs
 * update is one insert-only row. Local edits become rows (via `append`); rows from
 * other clients (or this client's reload) are applied back into the Y.Doc. Offline
 * edits queue as pending rows and flush on reconnect — fully local-first.
 *
 * Backend-agnostic: YOU supply the live `updates` and the `append`/`prune` callbacks,
 * so it works with any table name / scope shape. Bind an editor to the returned doc,
 * e.g. BlockNote → `doc.getXmlFragment("blocknote")`, TipTap → a `y-prosemirror` binding.
 *
 * ```ts
 * const updates = useLiveQuery(collection("doc_updates").scope({ workspaceId }).where(u => u.docId === docId)) ?? [];
 * const appendRow = useMutation(api.docUpdates.append);
 * const pruneRow = useMutation(api.docUpdates.prune);
 * const doc = useCollaborativeDoc({
 *   docId, updates,
 *   append: (update) => appendRow({ workspaceId, docId, update }).local,
 *   prune: (id) => pruneRow({ id }).local
 * });
 * ```
 */
export function useCollaborativeDoc(options: UseCollaborativeDocOptions): Y.Doc {
  const { docId, updates, compactThreshold = 50 } = options;

  // Latest callbacks via a ref so the update-handler effect doesn't re-subscribe on
  // every render when the caller passes fresh closures.
  const cbs = useRef(options);
  cbs.current = options;

  // Fresh Y.Doc (and applied-set) per document. Pairing them in one memo keeps the
  // dedup set tied to the exact doc instance it tracks.
  const { doc, applied } = useMemo(
    () => ({ doc: new Y.Doc(), applied: new Set<string>() }),
    [docId]
  );
  useEffect(() => () => doc.destroy(), [doc]);

  // Apply not-yet-applied rows (initial hydrate + live remote edits). Applying in any
  // order, or the same row twice, is safe (Yjs is a CRDT). REMOTE_ORIGIN marks these
  // so our own "update" handler below doesn't re-broadcast them as new rows.
  useEffect(() => {
    for (const u of updates) {
      if (applied.has(u._id)) continue;
      applied.add(u._id); // mark seen even on failure — a corrupt row is permanently bad
      applyUpdateSafe(doc, u.update, REMOTE_ORIGIN);
    }
  }, [updates, doc, applied]);

  // Compaction: when the row count crosses the threshold, write one snapshot row (the
  // whole doc state) and prune the rows it subsumes. Runs AFTER the apply effect above
  // (so `doc` already reflects every row we're about to subsume). Guarded so it fires
  // once per crossing; safe to race with other clients.
  const compacting = useRef(false);
  useEffect(() => {
    const prune = cbs.current.prune;
    if (!prune || compacting.current || updates.length <= compactThreshold) return;
    compacting.current = true;
    const subsumed = updates.map((u) => u._id); // every row now folded into `doc`
    const snapshot = makeSnapshot(doc); // = the full state these rows produced
    void (async () => {
      try {
        // Snapshot first (lower row position) so any peer that sees the deletes also
        // sees the snapshot that preserves their content.
        await cbs.current.append(snapshot);
        await Promise.all(subsumed.map((id) => prune(id)));
        // Drop dedup entries for pruned rows so `applied` can't grow without bound across
        // a doc's lifetime (the rows are gone; re-applying would be a no-op anyway).
        for (const id of subsumed) applied.delete(id);
      } finally {
        compacting.current = false;
      }
    })();
  }, [updates, doc, applied, compactThreshold]);

  // Persist local edits as rows. Skip REMOTE-origin updates (those just came from the
  // apply effect) — otherwise we'd echo every remote edit back as a new row.
  useEffect(() => {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      void cbs.current.append(bytesToBase64(update));
    };
    doc.on("update", handler);
    return () => doc.off("update", handler);
  }, [doc]);

  return doc;
}
