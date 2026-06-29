# DX v3 Spec

## North star

The framework must make Convex local-first without making the user stop writing Convex.

The main idea is **Convex-compatible surfaces, local-first internals**.

## User-facing surfaces

### React

Preferred explicit mode:

```tsx
import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "@convex-localfirst/react";
```

Optional alias mode:

```tsx
import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
```

Alias mode is enabled by the framework plugin.

### Server

Users define local-first tables with a Convex-friendly DSL:

```ts
const todos = lf.table("todos", {
  scope: lf.byUser("ownerId"),
  idField: "localId",
  conflict: lf.fieldLww(),
  indexes: {
    byList: ["ownerId", "listId", "createdAt"]
  }
});
```

Exported functions remain top-level Convex functions:

```ts
export const list = todos.query({
  args: { listId: v.string() },
  index: "byList",
  key: ({ auth, args }) => [auth.userId, args.listId],
  order: "asc",
  initial: []
});
```

## Local-first function detection

Generated code maps Convex function names to local-first definitions.

```ts
{
  "todos:list": {
    kind: "query",
    table: "todos"
  },
  "todos:create": {
    kind: "mutation",
    table: "todos"
  }
}
```

The React wrapper gets the function name from the Convex function reference and checks the generated manifest.

## Query semantics

Local-first query:

1. Read from local store.
2. Return `{ initial }` if no local data is available.
3. Subscribe to local store updates.
4. Schedule pull for the query scope.
5. Do not block on the network.

Normal Convex query:

1. Delegate to official Convex `useQuery`.
2. Preserve existing semantics.

## Mutation semantics

Local-first mutation:

1. Plan operation deterministically.
2. Apply operation to local store.
3. Durably append to outbox.
4. Return a hybrid promise with `.local` and `.server`.
5. Push in the background.
6. Rebase canonical server state when responses arrive.

Normal Convex mutation:

1. Delegate to official Convex `useMutation`.
2. Preserve existing semantics.

## Hybrid promise

```ts
export type LocalFirstMutationCall<T> = Promise<T> & {
  readonly opId: string;
  readonly local: Promise<LocalCommit>;
  readonly server: Promise<T>;
  readonly status: () => MutationStatus;
};
```

This allows three usage styles:

```ts
void create(args);
await create(args);
const call = create(args);
await call.local;
await call.server;
```

## Provider modes

### Explicit provider mode

```tsx
const convex = new ConvexReactClient(url);

<ConvexProvider client={convex} localFirst={{ manifest, transport }}>
  <App />
</ConvexProvider>
```

### Generated provider mode

`convex-localfirst init` generates a default manifest import. The provider can load it automatically in supported bundlers.

### Alias mode

The Vite plugin aliases `convex/react` to the enhanced wrapper and injects a virtual generated manifest module.

## Escape hatches

- `lf.serverOnly` for checkout, billing, email, AI calls, admin actions, and external side effects.
- `lf.customServerResolver` for conflict resolution that cannot run on the client.
- `useConvexFallbackQuery` and `useConvexFallbackMutation` for direct official Convex behavior.

## What should not be supported silently

- Arbitrary Convex queries running offline.
- Arbitrary server actions running offline.
- Cross-table transactions without explicit declarations.
- Pulling all rows for all users.
- Client-side authorization decisions.
- Direct writes to local-first tables outside generated wrappers.
