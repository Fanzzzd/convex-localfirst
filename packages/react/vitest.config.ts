import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    // Run type-level tests (*.test-d.ts) alongside runtime tests, so the headless
    // engine's convex type inference is actually verified, not just assumed.
    typecheck: { enabled: true }
  }
});
