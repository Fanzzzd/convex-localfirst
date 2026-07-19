import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // react/yjs tests exercise DOM hooks; everything else runs in node.
    environmentMatchGlobs: [
      ["tests/react/**", "jsdom"],
      ["tests/yjs/**", "jsdom"]
    ],
    // Run type-level tests (*.test-d.ts) alongside runtime tests, so the headless
    // engine's convex type inference is actually verified, not just assumed.
    typecheck: { enabled: true }
  }
});
