# Collaborative documents (Yjs) — plany integration blueprint

Plane issues carry a rich-text description; Plane's editor is Tiptap. This directory shows
how to make that description a **live collaborative document** on `convex-localfirst`, with
offline support, durable saves, and remote cursors — the reference wiring for plany.

The document rides the SAME local-first sync engine as every other table. There is no
separate websocket server: every Yjs edit is one insert-only row in a `doc_updates`
table, and the CRDT converges no matter the delivery order.

## What's in the example

| File | Compiled by `pnpm typecheck`? | Purpose |
| --- | --- | --- |
| [`../convex/doc_updates.ts`](../convex/doc_updates.ts) | ✅ yes | The `doc_updates` `lf.table` + `append`/`remove` mutations |
| `../convex/schema.ts`, `../convex/sync.ts` | ✅ yes | Table wired into the schema and the sync/access config |
| [`IssueDocEditor.tsx`](./IssueDocEditor.tsx) | ❌ blueprint | The Tiptap + `convex-localfirst/yjs` React component |

`IssueDocEditor.tsx` lives outside `convex/` on purpose: the example has no frontend, so
its `tsc` only compiles the Convex backend and does not pull in the editor peer deps.

## The table (`convex/doc_updates.ts`)

```ts
export const docUpdates = lf.table("doc_updates", {
  shape: { workspace: v.string(), doc: v.string(), update: v.string() },
  scope: scopeWorkspace,                       // doc access = workspace membership
  indexes: { byWorkspace: ["workspace"], byDoc: ["workspace", "doc"] }
});
export const append = docUpdates.insert();     // { workspace, doc, update }
export const remove = docUpdates.remove();      // { id }
```

Doc-level permissions come for free: `doc_updates` is workspace-scoped, so the server's
`access.member` / `read` / `write` hooks in `sync.ts` gate document reads and edits exactly
like issues (viewers read, members edit).

## The editor (`IssueDocEditor.tsx`)

To run it in a real frontend, install the editor peers:

```bash
pnpm add react react-dom yjs y-protocols \
  @tiptap/react @tiptap/pm @tiptap/starter-kit \
  @tiptap/extension-collaboration @tiptap/extension-collaboration-caret
```

Then the whole integration is three hooks:

```tsx
const updates = useLiveQuery(collection("doc_updates").scope({ workspace })) ?? [];
const append = useMutation(api.doc_updates.append);
const remove = useMutation(api.doc_updates.remove);

const { doc, status } = useCollaborativeDoc({
  docId: issueId,
  updates,                                    // ALL rows in scope — the provider filters to docId
  idField: "id",
  append: (update) => append({ workspace, doc: issueId, update }),
  prune: (id) => remove({ id }),
  compaction: { everyUpdates: 200 }           // snapshot + prune cadence (owned by the package)
});

const { awareness } = useDocAwareness(doc, {
  docId: issueId,
  scope: { workspace },
  state: { user },
  heartbeatMs: 200
});

const editor = useEditor({ extensions: [
  StarterKit.configure({ undoRedo: false }),  // Yjs owns history
  Collaboration.configure({ fragment: doc.getXmlFragment("prosemirror") }),
  CollaborationCaret.configure({ provider: { awareness }, user })
]}, [doc, awareness]);
```

`status` is `{ synced, pendingUpdates, lastError, compacting }` — render it as a save
indicator (the component shows "All changes saved" / "Saving…" / "Save error… retrying").

## Why this is safe (the guarantees the package owns)

- **No history loss on compaction.** A snapshot row is written and CONFIRMED server-side
  before any of the rows it subsumes are pruned. A rejected snapshot prunes nothing and is
  retried — so a crash or an offline device can never lose history to a local-only snapshot.
- **Durable saves.** Local edits are buffered and retried (never fire-and-forget). An edit
  is durable once its append persists locally; failures surface through `status.lastError`.
- **Deterministic, per-document scoping.** The provider applies only rows for its `docId`,
  in a deterministic order, deduped — so every mount folds the log in identically.
- **Offline-first.** Edits made offline queue as pending rows and sync on reconnect, and a
  cold device reconstructs the document from the log (or the latest snapshot) alone.
