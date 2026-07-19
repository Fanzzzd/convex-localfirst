import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/core/index";
import * as internalApi from "../../src/core/internal";

// I13: implementation internals must NOT leak into the public package surface,
// so they stay free to be rewritten without a semver break. The engine, rebase/replay,
// derived view, the DSL metadata contract, multi-tab leadership, and low-level
// id/ordering/db helpers all live behind "convex-localfirst/core/internal"; apps import
// wiring helpers from "../../src/core/index.js" and hooks from "../../src/react/index.js".
//
// This is a DENYLIST, not a frozen exact set. We guard the architectural property (known
// internals stay internal) and deliberately do NOT assert the exact public export list:
// adding a genuine new public export is a code decision and must not be vetoed by a test
// that demands editing a frozen list to stay green. Tests serve the code, not the reverse.
const MUST_BE_INTERNAL = [
  "LocalFirstEngine",
  "rebaseAndReplay",
  "deriveView",
  "nextCanonicalRow",
  "createFallbackMutationCall",
  "createLocalFirstMutationCall",
  "defaultFunctionName",
  "LF_METADATA_KEY",
  "TabLeadership",
  "compareOperations",
  "createOpId",
  "createDefaultIdFactory",
  "openLocalFirstDb",
  "INDEXED_DB_SCHEMA_VERSION"
];

describe("public API surface (I13)", () => {
  it("no engine/interpreter/leadership/low-level internal leaks into the public entry", () => {
    const keys = Object.keys(publicApi);
    for (const name of MUST_BE_INTERNAL) {
      expect(keys, `"${name}" must not be a public export`).not.toContain(name);
    }
  });

  it("the internal entry DOES expose the engine + DSL metadata contract for the adapters", () => {
    const keys = Object.keys(internalApi);
    for (const name of ["LocalFirstEngine", "createFallbackMutationCall", "defaultFunctionName", "LF_METADATA_KEY", "TabLeadership", "compareOperations", "createOpId", "openLocalFirstDb"]) {
      expect(keys, `"${name}" should be available on the internal entry`).toContain(name);
    }
  });

  it("the built public .d.ts carries no internal type vocabulary", () => {
    // Built before tests in the gate (build precedes test); the runtime checks above
    // are the floor when dist is stale.
    const dts = join(dirname(fileURLToPath(import.meta.url)), "../dist/index.d.ts");
    if (!existsSync(dts)) return;
    const text = readFileSync(dts, "utf8");
    // NOTE: "LocalFirstEngine" is intentionally absent here now — the headless factory
    // (createLocalFirstEngine) + the engine instance type are deliberately public. The
    // CLASS VALUE staying internal is asserted by the runtime allowlist + MUST_BE_INTERNAL.
    for (const token of ["rebaseAndReplay", "RebaseInput", "RebaseOutput", "deriveView", "LF_METADATA_KEY", "TabLeadership", "LeadershipOptions"]) {
      expect(text, `dist/index.d.ts must not mention "${token}"`).not.toContain(token);
    }
  });
});
