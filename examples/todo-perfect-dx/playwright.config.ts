import { defineConfig } from "@playwright/test";

// Drives the Linear-lite example in a real Chromium against the live local
// Convex backend (start it with `npx convex dev` first). Vite is launched by the
// webServer block below.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5173", trace: "off" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
