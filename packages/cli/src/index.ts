#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCheck } from "./check.js";
import { emitManifestSource, introspectExports, type ManifestEntry } from "./codegen.js";
import { checkManifestFreshness } from "./freshness.js";

const command = process.argv[2] ?? "help";

if (command === "init") {
  init();
} else if (command === "codegen") {
  await codegen();
} else if (command === "check") {
  check();
} else if (command === "dev") {
  await dev();
} else {
  help();
}

function init() {
  mkdirSync("convex", { recursive: true });
  mkdirSync("src", { recursive: true });

  // A COMPLETE, compiling, working starter: schema + factory + component mount +
  // server sync surface + one example table. Running `init` then `codegen` then
  // `npx convex dev` gives a live local-first backend with no hand-written sync.
  // Every file is write-if-absent, so re-running init never clobbers your edits.
  const files: Array<{ path: string; content: string }> = [
    {
      path: join("convex", "schema.ts"),
      content: `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Your app's own tables. ALL local-first sync bookkeeping (ledger / change log /
// id map / cursors / tombstones) lives in the mounted @convex-localfirst/component,
// so your schema only declares domain tables. Each local-first table needs a
// "localId" field + a "by_localId" index; scope indexes power the per-scope pull.
export default defineSchema({
  todos: defineTable({
    localId: v.string(),
    ownerId: v.string(),
    text: v.string(),
    done: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number()
  })
    .index("by_localId", ["localId"])
    .index("byOwner", ["ownerId", "createdAt"])
});
`
    },
    {
      path: join("convex", "localfirst.ts"),
      content: `import { createLocalFirst } from "@convex-localfirst/server";
import schema from "./schema";

// Auth is resolved server-side at sync time (convex/sync.ts → createSyncFunctions),
// not here — this factory only declares the local-first tables.
export const lf = createLocalFirst({
  schema,
  defaults: { idField: "localId", conflict: "fieldLww" }
});
`
    },
    {
      path: join("convex", "convex.config.ts"),
      content: `import { defineApp } from "convex/server";
import localfirst from "@convex-localfirst/component/convex.config.js";

// Mount the local-first component — the whole "no hand-written backend" promise:
// the sync ledger / change log / id map / cursors / tombstones come as a drop-in,
// referenced via components.convexLocalFirst.* in convex/sync.ts.
const app = defineApp();
app.use(localfirst);

export default app;
`
    },
    {
      path: join("convex", "sync.ts"),
      content: `import { createSyncFunctions } from "@convex-localfirst/server";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

// The entire server sync surface: declare which app tables are local-first + how
// they're scoped. createSyncFunctions wires app rows to ctx.db and all sync
// bookkeeping to the mounted component. Add a table here AND in convex/<table>.ts.
export const { push, pull } = createSyncFunctions({
  component: components.convexLocalFirst,
  mutation,
  query,
  tables: {
    todos: { scope: { kind: "byUser" as const, field: "ownerId" }, idField: "localId", conflict: "fieldLww" as const }
  },
  // Local dev with no auth provider trusts the client-supplied userId. In
  // production, DELETE this line and resolve identity from ctx.auth instead.
  devUnsafeAllowClientUserId: true
});
`
    },
    {
      path: join("convex", "todos.ts"),
      content: `import { v } from "convex/values";
import { lf } from "./localfirst";

// One local-first table. query/insert/patch/remove run OPTIMISTICALLY on the client
// and sync via convex/sync.ts — never call these handlers server-side.
const todos = lf.table("todos", {
  scope: lf.byUser("ownerId"),
  indexes: { byOwner: ["ownerId", "createdAt"] }
});

export const list = todos.query({
  args: {},
  index: "byOwner",
  key: ({ auth }) => [auth.userId],
  order: "asc",
  initial: []
});

export const create = todos.insert({
  args: { text: v.string() },
  value: ({ auth, args, now }) => ({
    ownerId: auth.userId,
    text: String(args.text),
    done: false,
    createdAt: now,
    updatedAt: now
  })
});

// id() defaults to the "id" arg; patch() is explicit only because it computes updatedAt.
export const toggle = todos.patch({
  args: { id: v.string(), done: v.boolean() },
  patch: ({ args, now }) => ({ done: Boolean(args.done), updatedAt: now })
});

// No id() / patch() needed — remove defaults to the "id" arg.
export const remove = todos.remove({ args: { id: v.string() } });
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
  1. npx convex-localfirst codegen   # generate src/convex-localfirst/generated.ts from the DSL
  2. npx convex dev                  # run the backend + live sync
  3. Wire the React client: <ConvexProvider client={convex} localFirst={{ manifest, transport, store }}>
     then useLiveQuery / useMutation (see the README "React hooks" section).`);
}

async function codegen() {
  const convexDir = existsSync("convex") ? "convex" : ".";
  const skip = new Set(["localfirst.ts", "schema.ts", "convex.config.ts"]);
  const moduleFiles = readdirSync(convexDir).filter(
    (f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts") && !skip.has(f)
  );

  const entries: ManifestEntry[] = [];
  const schemaVersion = 1;
  for (const file of moduleFiles) {
    const moduleName = file.replace(/\.(ts|js)$/, "");
    try {
      const mod = await import(pathToFileURL(resolve(convexDir, file)).href);
      entries.push(...introspectExports(moduleName, mod as Record<string, unknown>));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION/.test(message)) {
        console.error(
          `convex-localfirst codegen: cannot import ${file} as raw TypeScript. Run codegen under a TS loader, e.g.\n  node --import tsx node_modules/@convex-localfirst/cli/dist/index.js codegen`
        );
        process.exitCode = 1;
        return;
      }
      // A module that can't be imported standalone (e.g. it imports ./_generated
      // or a mounted component — Convex-runtime-only) is not a local-first table
      // module, so skip it rather than failing the whole codegen run.
      console.warn(`convex-localfirst codegen: skipped ${file} (not importable standalone: ${message.split("\n")[0]})`);
    }
  }

  if (entries.length === 0) {
    console.error(
      "convex-localfirst codegen: found no local-first functions. Define tables with `lf.table(...).query/insert/patch/remove`."
    );
    process.exitCode = 1;
    return;
  }

  const outDir = join("src", "convex-localfirst");
  const outFile = join(outDir, "generated.ts");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, emitManifestSource(schemaVersion, entries));
  const tables = new Set(entries.map((e) => e.tableMeta.table));
  console.log(
    `convex-localfirst codegen: wrote ${outFile} (${entries.length} functions across ${tables.size} table(s)).`
  );
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
  // Warn (don't fail) if the generated manifest is older than a DSL source — the safety net
  // that used to live in the Vite plugin, now folded in so CI `check` catches a stale manifest.
  checkManifestFreshness(process.cwd(), dir, "src/convex-localfirst/generated.ts", console.warn);
  const violations = runCheck(dir);
  if (violations.length === 0) {
    console.log("convex-localfirst check: no direct writes to local-first tables found");
    console.log(`convex-localfirst check: ${CHECK_SCOPE_NOTE}`);
    return;
  }
  console.error(`convex-localfirst check: found ${violations.length} direct write(s) to local-first tables:`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ctx.db.${v.method}("${v.table}", ...)  — use the generated wrapper`);
    console.error(`    ${v.snippet}`);
  }
  console.error(`convex-localfirst check: ${CHECK_SCOPE_NOTE}`);
  process.exitCode = 1;
}

async function dev() {
  // The dev-time pipeline: regenerate the client manifest from the DSL, then
  // statically verify nothing writes a local-first table directly. The Convex
  // backend itself is run separately with `npx convex dev`.
  console.log("convex-localfirst dev: regenerating manifest + checking for direct local-first writes…");
  await codegen();
  check();
  console.log("convex-localfirst dev: done. Run `npx convex dev` for the backend and live sync.");
}

function help() {
  console.log(`convex-localfirst commands:
  init
  codegen
  check
  dev`);
}
