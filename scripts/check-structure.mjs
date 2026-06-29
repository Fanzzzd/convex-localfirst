import { existsSync } from "node:fs";

const required = [
  "packages/core/src/index.ts",
  "packages/react/src/index.tsx",
  "packages/server/src/index.ts",
  "packages/component/convex/schema.ts",
  "packages/cli/src/index.ts",
  "AGENT_LOOP_GOAL_PROMPT.md"
];

let ok = true;
for (const path of required) {
  if (!existsSync(path)) {
    console.error(`Missing ${path}`);
    ok = false;
  }
}

if (!ok) {
  process.exit(1);
}

console.log("Structure check passed");
