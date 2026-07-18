#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "./check.js";

const command = process.argv[2] ?? "help";

if (command === "init") {
  init();
} else if (command === "check") {
  check();
} else {
  help();
}

function init() {
  mkdirSync("convex", { recursive: true });

  // A COMPLETE, compiling, working starter: one shape-based lf.table module is the
  // single source of truth — the schema derives from it (todos.table()), the server
  // sync config derives from it (collectTables), and the client manifest derives
  // from it at runtime (collectManifest via the provider's `modules`). No codegen.
  // Every file is write-if-absent, so re-running init never clobbers your edits.
  const files: Array<{ path: string; content: string }> = [
    {
      path: join("convex", "localfirst.ts"),
      content: `import { createLocalFirst } from "convex-localfirst/server";

// Auth is resolved server-side at sync time (convex/sync.ts → createSyncFunctions),
// not here — this factory only declares the local-first tables.
export const lf = createLocalFirst();
`
    },
    {
      path: join("convex", "todos.ts"),
      content: `import { v } from "convex/values";
import { lf } from "./localfirst";

// THE single source of truth for this table: its shape, scope, and indexes.
// convex/schema.ts derives the Convex table from it (todos.table()); the client
// runs these same declarations locally (optimistic, offline) and syncs them.
export const todos = lf.table("todos", {
  shape: {
    ownerId: v.string(),
    text: v.string(),
    done: v.boolean()
  },
  scope: lf.byUser("ownerId"),
  timestamps: true, // adds createdAt/updatedAt, stamped automatically
  indexes: { byOwner: ["ownerId", "createdAt"] }
});

export const list = todos.query({
  args: {},
  index: "byOwner",
  key: ({ auth }) => [auth.userId],
  order: "asc",
  initial: []
});

// Custom insert only because \`done\` defaults to false instead of being an arg.
// (\`todos.insert()\` with no spec derives args from the shape.)
export const create = todos.insert({
  args: { text: v.string() },
  value: ({ auth, args }) => ({ ownerId: auth.userId, text: args.text, done: false })
});

// No patch() closure: args forward 1:1, updatedAt stamps automatically.
export const toggle = todos.patch({
  args: { id: v.string(), done: v.boolean() }
});

export const remove = todos.remove();
`
    },
    {
      path: join("convex", "schema.ts"),
      content: `import { defineSchema } from "convex/server";
import { todos } from "./todos";

// Derived, never restated: todos.table() adds the localId field + indexes from
// the lf.table declaration. ALL sync bookkeeping (ledger / change log / id map /
// cursors) lives in the mounted @convex-localfirst/component, not here.
export default defineSchema({
  todos: todos.table()
});
`
    },
    {
      path: join("convex", "convex.config.ts"),
      content: `import { defineApp } from "convex/server";
import localfirst from "convex-localfirst/component/convex.config.js";

// Mount the local-first component — the whole "no hand-written backend" promise:
// the sync ledger / change log / id map / row versions come as a drop-in,
// referenced via components.convexLocalFirst.* in convex/sync.ts.
const app = defineApp();
app.use(localfirst);

export default app;
`
    },
    {
      path: join("convex", "sync.ts"),
      content: `import { collectTables, createSyncFunctions } from "convex-localfirst/server";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import * as todos from "./todos";

// The entire server sync surface. collectTables derives scope/idField
// from the imported lf.table modules — add a new table by adding its import.
export const { push, pull, presence, presenceList } = createSyncFunctions({
  component: components.convexLocalFirst,
  mutation,
  query,
  tables: collectTables({ todos }),
  // Local dev with no auth provider trusts the client-supplied userId. In
  // production, DELETE this line and resolve identity from ctx.auth instead.
  devUnsafeAllowClientUserId: true
});
`
    }
  ];

  const created: string[] = [];
  const skipped: string[] = [];
  for (const { path, content } of files) {
    if (existsSync(path)) {
      skipped.push(path);
      continue;
    }
    writeFileSync(path, content);
    created.push(path);
  }

  console.log("convex-localfirst init: scaffolded a complete local-first starter.");
  if (created.length) console.log(`  created: ${created.join(", ")}`);
  if (skipped.length) console.log(`  kept (already existed): ${skipped.join(", ")}`);
  console.log(`
Next:
  1. npx convex dev            # deploy the app + component, keep the backend running
  2. Wire the React client (no codegen — the client imports your convex modules):

       import * as todos from "../convex/todos";

       <ConvexProvider client={convex} localFirst={{ modules: { todos }, userId }}>

     then use useQuery(api.todos.list) / useMutation(api.todos.create) from
     "convex-localfirst" exactly like Convex.`);
}

// Coverage: regex catches ctx.db.insert("<lfTable>", …); an AST taint pass catches
// ctx.db.patch/delete/replace on ids that provably come from a local-first table
// (handler `v.id("lf")` args, `const doc = await ctx.db.query("lf")…first()`, and
// inline query-then-write). The pass is sound (no false positives) but function-scoped:
// ids passed across function boundaries or through ctx.db.get() are not traced.
const CHECK_SCOPE_NOTE =
  "note: catches ctx.db.insert + id-based patch/delete/replace whose id is traceable to a local-first table within one function; ids passed across functions or via ctx.db.get() are not traced — review those manually.";

function check() {
  const dir = existsSync("convex") ? "convex" : ".";
  const violations = runCheck(dir);
  if (violations.length === 0) {
    console.log("convex-localfirst check: no direct writes to local-first tables found");
    console.log(`convex-localfirst check: ${CHECK_SCOPE_NOTE}`);
    return;
  }
  console.error(`convex-localfirst check: found ${violations.length} direct write(s) to local-first tables:`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ctx.db.${v.method}("${v.table}", ...)  — write through the lf.table DSL instead`);
    console.error(`    ${v.snippet}`);
  }
  console.error(`convex-localfirst check: ${CHECK_SCOPE_NOTE}`);
  process.exitCode = 1;
}

function help() {
  console.log(`convex-localfirst commands:
  init    scaffold a complete local-first Convex starter
  check   statically verify nothing writes local-first tables with ctx.db directly`);
}
