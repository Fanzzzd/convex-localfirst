import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { checkManifestFreshness, staleManifestSources } from "../src/freshness.js";

describe("staleManifestSources (pure)", () => {
  it("is fresh when the manifest is newer than every source", () => {
    expect(staleManifestSources(100, [{ file: "convex/schema.ts", mtimeMs: 50 }])).toEqual([]);
  });

  it("flags every source modified after the manifest", () => {
    const stale = staleManifestSources(100, [
      { file: "convex/schema.ts", mtimeMs: 150 },
      { file: "convex/todos.ts", mtimeMs: 80 },
      { file: "convex/cycles.ts", mtimeMs: 200 }
    ]);
    expect(stale).toEqual(["convex/schema.ts", "convex/cycles.ts"]);
  });

  it("treats a missing manifest as fully stale (run codegen)", () => {
    expect(staleManifestSources(null, [{ file: "convex/schema.ts", mtimeMs: 1 }])).toEqual(["convex/schema.ts"]);
  });
});

describe("checkManifestFreshness (fs)", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function setup(): { schema: string; manifest: string } {
    root = mkdtempSync(join(tmpdir(), "clf-cli-"));
    mkdirSync(join(root, "convex"));
    mkdirSync(join(root, "src", "convex-localfirst"), { recursive: true });
    const schema = join(root, "convex", "schema.ts");
    const manifest = join(root, "src", "convex-localfirst", "generated.ts");
    writeFileSync(schema, "// schema");
    writeFileSync(manifest, "// manifest");
    return { schema, manifest };
  }

  it("warns when a convex source is newer than the manifest", () => {
    const { schema, manifest } = setup();
    utimesSync(manifest, new Date(1000), new Date(1000));
    utimesSync(schema, new Date(5000), new Date(5000)); // edited after codegen
    const warnings: string[] = [];
    checkManifestFreshness(root, "convex", "src/convex-localfirst/generated.ts", (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("stale");
    expect(warnings[0]).toContain("convex/schema.ts");
    expect(warnings[0]).toContain("codegen");
  });

  it("stays silent when the manifest is newer than all sources", () => {
    const { schema, manifest } = setup();
    utimesSync(schema, new Date(1000), new Date(1000));
    utimesSync(manifest, new Date(5000), new Date(5000)); // regenerated after the edit
    const warnings: string[] = [];
    checkManifestFreshness(root, "convex", "src/convex-localfirst/generated.ts", (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  it("does nothing when there is no convex dir", () => {
    root = mkdtempSync(join(tmpdir(), "clf-cli-"));
    const warnings: string[] = [];
    checkManifestFreshness(root, "convex", "src/convex-localfirst/generated.ts", (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});
