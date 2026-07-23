import { defineConfig } from "vitest/config";

// Unit tests only (the Playwright e2e lives in tests/e2e/*.spec.ts and runs via
// vitest).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
