// Blueprint: a collaborative Tiptap editor for a Plane issue description, synced through
// convex-localfirst's Yjs document mode. This is the plany integration reference — the
// same wiring plany's Tiptap editor uses.
//
// It lives OUTSIDE convex/ so the example's `tsc` (which only compiles convex/) does not
// require the editor peer deps. To run it in a real frontend, install:
//
//   pnpm add react react-dom yjs y-protocols \
//     @tiptap/react @tiptap/pm @tiptap/starter-kit \
//     @tiptap/extension-collaboration @tiptap/extension-collaboration-caret
//
// The convex model (convex/doc_updates.ts + schema/sync wiring) IS compiled and tested.

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { collection, useLiveQuery, useMutation } from "convex-localfirst/react";
import { useCollaborativeDoc } from "convex-localfirst/yjs";
import { useDocAwareness } from "convex-localfirst/yjs/awareness";
import { api } from "../convex/_generated/api";

export interface IssueDocEditorProps {
  /** Workspace slug — the sync scope for doc_updates (membership enforced server-side). */
  readonly workspace: string;
  /** Which document this editor edits (a Plane issue id, a page id, ...). One editor per
   *  document; pass `key={issueId}` from the parent so it remounts on navigation. */
  readonly issueId: string;
  /** The signed-in user, for the awareness cursor. */
  readonly user: { readonly name: string; readonly color: string };
}

export function IssueDocEditor({ workspace, issueId, user }: IssueDocEditorProps) {
  // ALL doc_updates rows in the workspace. The provider filters to this issue's document
  // itself (docId scoping is the package's job, not the query's). `.where(u => u.doc ===
  // issueId)` is a valid optimization but not required for correctness.
  const updates = useLiveQuery(collection("doc_updates").scope({ workspace })) ?? [];

  const append = useMutation(api.doc_updates.append);
  const remove = useMutation(api.doc_updates.remove);

  // The Yjs document over the append-only log. The hook owns durability (retried appends,
  // never fire-and-forget) and crash-safe compaction (server-confirmed snapshot before any
  // prune) — the app just supplies the table wiring. `status` surfaces pending/error state.
  const { doc, status } = useCollaborativeDoc({
    docId: issueId,
    updates,
    idField: "id", // Plane rows key on "id"; that is also what `remove({ id })` expects
    append: (update) => append({ workspace, doc: issueId, update }),
    prune: (id) => remove({ id }),
    // Snapshot + prune once ~200 update rows accumulate for this document.
    compaction: { everyUpdates: 200 }
  });

  // Cursor/selection presence over the package's presence transport. Low heartbeat so
  // cursors feel live (presence broadcasts on the beat).
  const { awareness } = useDocAwareness(doc, {
    docId: issueId,
    scope: { workspace },
    state: { user },
    heartbeatMs: 200
  });

  const editor = useEditor(
    {
      extensions: [
        // Yjs owns undo/redo — disable Tiptap's history so the two don't fight.
        StarterKit.configure({ undoRedo: false }),
        // Content <-> Y.Doc. The XML fragment name must match across all clients.
        Collaboration.configure({ fragment: doc.getXmlFragment("prosemirror") }),
        // Remote carets/selections, driven by our awareness instance.
        CollaborationCaret.configure({ provider: { awareness }, user })
      ]
    },
    [doc, awareness]
  );

  return (
    <div className="issue-doc-editor">
      <div className="issue-doc-editor__status" aria-live="polite">
        {status.lastError
          ? `Save error: ${status.lastError.message} (retrying)`
          : status.compacting
            ? "Optimizing history…"
            : status.synced
              ? "All changes saved"
              : `Saving ${status.pendingUpdates} change(s)…`}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
