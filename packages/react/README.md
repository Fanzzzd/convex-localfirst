# @convex-localfirst/react

Convex-compatible React hooks for local-first, offline-capable apps. Keep writing
`useQuery` / `useMutation` — local-first tables read and write optimistically, work
offline, and sync in the background, with Convex as the source of truth.

```bash
npm install @convex-localfirst/react
```

```tsx
import { useMutation, useQuery, useSyncStatus } from "@convex-localfirst/react";
import { api } from "../convex/_generated/api";

export function Todos({ listId }: { listId: string }) {
  const todos = useQuery(api.todos.list, { listId }, { initial: [] });
  const create = useMutation(api.todos.create);
  const sync = useSyncStatus();

  return (
    <button disabled={sync.blockedBySchemaMismatch} onClick={() => create({ listId, text: "Ship it" })}>
      Add {todos.length} todos
    </button>
  );
}
```

Peer dependencies: `convex`, `react`. MIT
