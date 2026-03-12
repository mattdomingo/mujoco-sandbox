import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,       // MuJoCo WASM boot can take ~15s
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    // COOP/COEP headers are required for SharedArrayBuffer (WASM).
    // The Next.js dev server sets them via next.config.ts — no extra config needed here.
    headless: true,
    browserName: "chromium",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Do NOT start the dev server automatically — user must run `npm run dev` first.
  // This keeps the test run fast and avoids port conflicts.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
