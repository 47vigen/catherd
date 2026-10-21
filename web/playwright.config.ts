import { defineConfig, devices } from "@playwright/test";

// A seeded catherd panel (test/panel-e2e-serve.ts): no model, no daemon, no backend CLI. The webServer starts it from
// web/ and it writes where its runs live to the state file; PLAYWRIGHT_CHROMIUM_EXECUTABLE optionally selects a
// Chromium that is already installed.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  // The tests share one server, its runs and its profile; keep them in order.
  workers: 1,
  reporter: "list",
  // apart from the state file, which Playwright would otherwise clean with the rest of test-results
  outputDir: "test-results/pw",
  use: {
    baseURL: "http://127.0.0.1:4318",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun ../test/panel-e2e-serve.ts",
    url: "http://127.0.0.1:4318/login",
    reuseExistingServer: false,
    env: { CATHERD_E2E_STATE: "test-results/e2e-state.json" },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
      },
    },
  ],
});
