import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Which source files were modified after the manifest. `manifestMtimeMs` is null when the
 * manifest doesn't exist (→ everything counts as stale, i.e. "run codegen"). Pure so it's
 * unit-testable without fs.
 */
export function staleManifestSources(
  manifestMtimeMs: number | null,
  sources: ReadonlyArray<{ readonly file: string; readonly mtimeMs: number }>
): string[] {
  if (manifestMtimeMs == null) {
    return sources.map((s) => s.file);
  }
  return sources.filter((s) => s.mtimeMs > manifestMtimeMs).map((s) => s.file);
}

/**
 * Read the convex source dir + the generated manifest and warn (once) if the manifest looks
 * stale — so editing a `lf.table` and forgetting `codegen` can't silently ship a mismatched
 * client. Best-effort: silent when there's no convex dir. `warn` is injected for tests.
 */
export function checkManifestFreshness(
  root: string,
  convexDir: string,
  generatedManifestPath: string,
  warn: (message: string) => void
): void {
  const convexAbs = resolve(root, convexDir);
  if (!existsSync(convexAbs)) {
    return;
  }
  const manifestAbs = resolve(root, generatedManifestPath.replace(/^\//, ""));
  const manifestMtimeMs = existsSync(manifestAbs) ? statSync(manifestAbs).mtimeMs : null;

  const sources = readdirSync(convexAbs)
    .filter((f) => /\.(ts|js)$/.test(f) && !f.startsWith("_") && !f.endsWith(".d.ts"))
    .map((f) => ({ file: join(convexDir, f), mtimeMs: statSync(join(convexAbs, f)).mtimeMs }));

  const stale = staleManifestSources(manifestMtimeMs, sources);
  if (stale.length === 0) {
    return;
  }
  const shown = stale.slice(0, 3).join(", ") + (stale.length > 3 ? `, +${stale.length - 3} more` : "");
  warn(
    `[convex-localfirst] generated manifest looks stale: ${stale.length} convex source(s) changed after ` +
      `"${generatedManifestPath}" (${shown}). Run \`npx convex-localfirst codegen\` to regenerate it.`
  );
}
