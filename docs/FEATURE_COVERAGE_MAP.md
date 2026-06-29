# Feature Coverage Map

## MVP

| Feature | Required | Package |
| --- | --- | --- |
| Convex-compatible hooks | yes | react |
| fallback to official Convex | yes | react |
| local CRUD tables | yes | server, core |
| durable outbox | yes | core |
| memory store | yes | core |
| IndexedDB store | yes | core |
| sync push and pull | yes | core, component |
| by-user scope | yes | server, component |
| field LWW conflict | yes | core |
| server idempotency | yes | component |
| codegen manifest | yes | cli |
| direct write checker | yes | cli |

## Next

| Feature | Required | Package |
| --- | --- | --- |
| by-workspace scope | yes | server, component |
| multi-tab leader | yes | core |
| BroadcastChannel | yes | core |
| devtools | yes | devtools |
| Vite alias mode | yes | vite |
| React Native storage | later | storage package |
| CRDT docs | later | automerge, yjs |
