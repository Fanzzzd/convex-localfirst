# @convex-localfirst/cli

Command-line tooling for convex-localfirst:

- **`codegen`** — derive the client manifest from your `lf.table` DSL.
- **`check`** — statically catch direct `ctx.db.insert/replace` writes to local-first
  tables (a security guard; these must go through the generated wrappers).
- **`dev`** — run the codegen + check pipeline.

```bash
npm install -D @convex-localfirst/cli
# run under a TS loader so it can read your TypeScript Convex modules:
node --import tsx node_modules/@convex-localfirst/cli/dist/index.js codegen
```

Peer dependency: `typescript`. MIT
