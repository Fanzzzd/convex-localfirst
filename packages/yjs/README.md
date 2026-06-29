# @convex-localfirst/yjs

Ship a [Yjs](https://github.com/yjs/yjs) CRDT (rich text, nested lists) over the
convex-localfirst append-only log: each Yjs update is one insert-only row, so concurrent
rich-text edits **merge** instead of last-writer-wins clobbering. Includes a framework-
agnostic base64 codec, snapshot compaction, and a React `useCollaborativeDoc` hook.

```bash
npm install @convex-localfirst/yjs
```

Peer dependencies: `react`, `yjs`. MIT
