import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { collection, useLiveQuery, useMutation } from "convex-localfirst/react";
import { useCollaborativeDoc } from "convex-localfirst/yjs";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";

// A Notion-style block editor whose content is a Yjs CRDT, synced through our
// local-first layer (doc_updates rows). Mount one per document — the PARENT must
// pass a `key={docId}` so the editor + Y.Doc are rebuilt when the doc changes.
//
// All the Yjs↔log machinery (Y.Doc lifecycle, dedup, apply, compaction, echo-guard)
// lives in convex-localfirst/yjs's `useCollaborativeDoc`. This component only wires
// it to THIS app's doc_updates table: a live query for the rows + append/prune.
export function DocEditor({
  docId,
  workspaceId,
  user,
}: {
  docId: string;
  workspaceId: string;
  user: string;
}) {
  const updates =
    useLiveQuery(
      collection<Doc<"doc_updates">>("doc_updates")
        .scope({ workspaceId })
        .where((u) => u.docId === docId),
      // Poll so a collaborator's edits land live while this doc is open, even with
      // no local activity (true real-time multiplayer).
      { pollMs: 800 },
    ) ?? [];
  const appendRow = useMutation(api.docUpdates.append);
  const pruneRow = useMutation(api.docUpdates.prune);

  // Pass the whole mutation call (not `.local`): compaction awaits `.server`
  // confirmation of the snapshot before pruning, so history is never lost.
  const { doc } = useCollaborativeDoc({
    docId,
    updates,
    append: (update) => appendRow({ workspaceId, docId, update }),
    prune: (id) => pruneRow({ id }),
  });

  const editor = useCreateBlockNote({
    collaboration: {
      // BlockNote stores its blocks in this fragment; both clients use the same
      // name so their fragments converge as updates sync.
      fragment: doc.getXmlFragment("blocknote"),
      user: { name: user, color: "#6366f1" },
      // provider omitted: presence/cursor sharing would need an awareness channel
      // (ephemeral); document CONTENT syncs via the Y.Doc update stream above.
    },
  });
  return <BlockNoteView editor={editor} data-testid="doc-editor" className="min-h-[60vh]" />;
}
