import { defineConfig, devices } from "@playwright/test";
import { E2E_PORTS } from "./dev/stack-env.js";

/**
 * End-to-end learner, admin and security journeys (TS-E2E, TS-SCORM subset, TS-A11Y) against the full local
 * stack: LMS app and content origins, the local test IdP (not miniOrange) and the HubSpot stub (not HubSpot).
 * The stack starts on a freshly reset lms_e2e database.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${E2E_PORTS.app}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile\.spec/ },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec/ },
  ],
  webServer: {
    command: "npx tsx dev/dev-stack.ts",
    url: `http://localhost:${E2E_PORTS.app}/health`,
    env: { DEV_DB: "lms_e2e", DEV_RESET: "true", LOG_LEVEL: "warn" },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
