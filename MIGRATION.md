# Migrating 0.3.x → 0.4

0.4 is a pre-1.0 breaking release. It keeps the Convex-compatible `useQuery` /
`useMutation` layer you already use, and adds the large v4 surface (typed `db`,
declared relations, filters, grouping, batches, permissions UI, undo, search,
attachments, recovery, testing, devtools) on top.

This guide has two parts:

1. **[Breaking changes](#breaking-changes)** — what you must change to keep an
   existing 0.3.x app working.
2. **[The new v4 surface](#the-new-v4-surface)** — old → new mappings you can
   adopt incrementally (nothing here is required).

Bump the dependency and the Convex peer:

```bash
npm install convex-localfirst@^0.4          # convex >=1.16.1 is now required
```

---

## Breaking changes

### 1. `access = { member, read, write }` replaces `isMember` / `visibility`

Authorization is now one `access` object. `member` returns a **role** (any value)
or `null`/`undefined` to deny both pull and push; `read` filters rows within a
scope; `write` authorizes **every** accepted op, including inserts (this closes
insert-time authz gaps that `isMember` alone couldn't express). Omitted
`read`/`write` default to allowing members. `byUser` tables stay owner-only.

```ts
// Before (0.3.x)
createSyncFunctions({
  component, mutation, query, tables,
  isMember: async (ctx, { userId, scopeValue }) => await isWorkspaceMember(ctx, userId, scopeValue),
  visibility: (_ctx, { userId, row }) => row.created_by === userId
});

// After (0.4)
createSyncFunctions({
  component, mutation, query, tables,
  access: {
    // Return a role (string, number, object — anything) or null to deny.
    member: async (ctx, { userId, scopeValue }) => await roleForWorkspace(ctx, userId, scopeValue),
    // `read` receives the role; "viewer reads all, guest reads own" is now representable.
    read:  (_ctx, { role, userId, row }) => role !== "guest" || row.created_by === userId,
    // `write` runs on insert/patch/delete — authorize the actual mutation.
    write: (_ctx, { role, userId, action, before, proposed }) =>
      role === "admin" ||
      (action === "insert" ? proposed?.created_by === userId : before?.created_by === userId)
  }
});
```

If a `byWorkspace`/`byProject` table is configured without `access.member`,
`createSyncFunctions` now throws a clear error instead of silently allowing access.

### 2. `serverStamp` is now `{ fields, stamp }`, not a bare function

Server-minted insert fields must declare the complete set of field names they may
return, so those fields can be rejected from client writes before the hook runs.

```ts
// Before (0.3.x)
serverStamp: {
  issues: async (ctx, { value }) => ({ sequence_id: await nextCounter(ctx, value.project_id) })
}

// After (0.4)
serverStamp: {
  issues: {
    fields: ["sequence_id"],
    stamp: async (ctx, { userId, value }) => ({ sequence_id: await nextCounter(ctx, value.project_id) })
  }
}
```

A stamped field must be in the table's `shape` (declare it `v.optional(...)` so
clients don't supply it) and may not be the id or scope field. Mirror the field
names on the client with `lf.table({ serverFields: ["sequence_id"] })` so
undo-of-delete strips them before re-inserting (the server re-mints them on
resurrection).

### 3. `useCollaborativeDoc` returns `{ doc, status }` and takes the whole mutation call

It no longer returns a bare `Y.Doc`, and it now owns docId scoping, dedup, durable
retried appends, and server-confirmed compaction. `append`/`prune` must return the
**whole `useMutation` call** (not `.local`) so the provider can drive durability
from its `.local` / `.server` stages.

```tsx
// Before (0.3.x)
const doc = useCollaborativeDoc({
  docId, updates,
  append: (update) => appendRow({ workspace, doc: docId, update }).local, // ← .local
  prune: (id) => pruneRow({ id }).local
});
// you filtered `updates` to docId yourself, and had no durability/compaction status

// After (0.4)
const { doc, status } = useCollaborativeDoc({
  docId, updates, idField: "id",
  append: (update) => appendRow({ workspace, doc: docId, update }), // ← whole call
  prune: (id) => pruneRow({ id })
});
// status: { synced, pendingUpdates, lastError, compacting }
// the hook filters `updates` to `docId` internally — pass all in-scope rows
```

### 4. Default identity is `identity.tokenIdentifier` (was `identity.subject`)

The server-authoritative user id now defaults to `identity.tokenIdentifier`,
preventing a `subject` (`sub`) value colliding across auth providers from granting
cross-user access.

> **⚠️ This changes existing user ids — and scope keys are derived from them.**
> Every `byUser` row's owner field, every `byWorkspace`/`byProject` membership
> lookup, and the per-user local store namespace were keyed on the old `subject`.
> Under the new default they key on `tokenIdentifier`, so **existing data will not
> match a returning user** unless you act. Pick one:

**Option A — keep the old ids (zero data migration).** Override `getUserId` to
return `subject`, exactly as before:

```ts
createSyncFunctions({
  component, mutation, query, tables, access,
  getUserId: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null
});
```

This is the safe, no-downtime choice for an app already in production. (Be aware
of the original caveat: raw `subject` can collide across providers — only a
concern if you use more than one auth provider.)

**Option B — migrate to `tokenIdentifier`.** Adopt the new default and re-key
existing data with a one-time migration: for every local-first table, rewrite the
owner/scope field and every membership row from each user's old `subject` to their
`tokenIdentifier`. Do this while the app is drained (or behind a maintenance flag)
so no writes race the re-key, then remove any `getUserId` override.

Whichever you choose, decide **before** deploying 0.4 — a returning user who hits
the new id with un-migrated data will appear to have lost their rows (they are
still on the server under the old key).

### 5. `convex` peer is now `>=1.16.1`

The mounted component requires it. Tested against `^1.41`. Update your `convex`
dependency if you are on an older release.

### 6. The component ships compiled exports

`convex-localfirst/component` now ships compiled JS + `.d.ts` under
`dist/component`, with the raw TypeScript behind the `@convex-dev/component-source`
export condition (the Convex bundler's live-sources mode). No app change is needed
— `app.use(localfirst)` and `components.convexLocalFirst.*` work as before — but if
you pinned deep component paths, use the public entry
`convex-localfirst/component/convex.config.js`.

### Minor: hook arg arity

`useQuery` / `useMutation` now mirror Convex's `OptionalRestArgs`: functions with
required args require the args parameter (omitting it is a compile error);
empty-args functions may be called without it. If you relied on omitting required
args, add them.

---

## The new v4 surface

None of this is required — the 0.3.x patterns still work. But for a complex app,
the v4 surface removes a lot of hand-written glue. Adopt it table by table.

| You were doing this (0.3.x) | Prefer this (0.4) |
| --- | --- |
| `collection<Doc<"issues">>("issues")` — stringly, self-typed | `createLocalDb({ issues, … })` → `db.issues` — typed from the schema |
| Per-query relation combinators (`.related`/`.withRelations` with `one`/`many`/`manyToMany`) on every call site | Declare `relations` once on `lf.table`, query by name: `.with("state", "labels")` |
| `.where(row => row.state_id === id)` for everything | `.filter({ state_id: id })` — typed, index-plannable, serializable (saved views); keep `.where(fn)` for the long tail |
| Fetch all rows, `reduce` into columns/counts per render | `.groupBy("state_id")` + `useLiveCounts(...)` — incrementally maintained |
| Hand-rolled optimistic multi-writes with manual rollback | `useBatch()` — one atomic, offline-durable group that reverts as a unit |

### `collection()` → typed `db`

```ts
// Before
import { collection, useLiveQuery } from "convex-localfirst";
const rows = useLiveQuery(
  collection<Doc<"issues">>("issues").scope({ workspaceId }).where((i) => i.state_id === stateId)
);

// After
import { createLocalDb, useLiveQuery } from "convex-localfirst";
export const db = createLocalDb({ issues, states, labels }); // once, in src/lib/db.ts
const rows = useLiveQuery(db.issues.scope({ workspace_id: workspaceId }).filter({ state_id: stateId }));
// rows: Issue[] — row type, scope keys, and filter fields all inferred from the schema
```

`collection()` remains as the untyped escape hatch.

### Per-query relations → declared relations + `.with()`

```ts
// Before — assembled per query, far from the table
import { one, many } from "convex-localfirst";
useLiveQuery(
  collection<Doc<"issues">>("issues").scope({ workspaceId })
    .related("state", one<Doc<"states">>("states", "state_id"))
    .withRelations({ labels: viaIds<Doc<"labels">>("labels", "label_ids") })
);

// After — declared once on lf.table, named at the call site
// lf.table("issues", { relations: { state: lf.one("states","state_id"),
//                                    labels: lf.many("labels", { via: "label_ids" }) } })
useLiveQuery(db.issues.scope({ workspace_id: workspaceId }).with("state", "labels"));
// row.state: State | null, row.labels: Label[] — inferred
```

### `.where(fn)` → `.filter(AST)` for serializable queries

Saved views are serialized queries. A closure can't be persisted or index-planned;
the filter AST can:

```ts
// Before
collection<Doc<"issues">>("issues").where((i) => stateIds.includes(i.state_id) && i.priority === "urgent");

// After
db.issues.filter({ state_id: { in: stateIds }, priority: "urgent" });
// serializeFilter(spec) -> store as a `views` row; parseFilter<Shape>(json) -> validated replay
```

### Manual reduce → `groupBy` / `useLiveCounts`

```ts
// Before
const all = useLiveQuery(collection<Doc<"issues">>("issues").scope({ workspaceId })) ?? [];
const columns = groupByState(all);           // recomputed every render
const counts = countByState(all);

// After
const columns = useLiveQuery(db.issues.scope({ workspace_id: workspaceId }).groupBy("state_id")); // Map
const counts  = useLiveCounts(db.issues.scope({ workspace_id: workspaceId }).groupBy("state_id")); // Record
// incrementally maintained — a moved card touches two groups, not a full rescan
```

### Hand-rolled multi-writes → `useBatch`

```ts
// After — atomic, offline-durable, reverts as one unit on rejection
const batch = useBatch();
await batch(() => {
  const { id } = create({ workspace_id, title, /* … */ });
  comment({ workspace_id, issue_id: id, body });
}).local;
```

See the [README](./README.md) and the docs site for the full v4 surface.
