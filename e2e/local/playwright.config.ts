// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig, devices } from "@playwright/test"

/**
 * Playwright E2E config for tests that require Shogo running in local
 * desktop / SHOGO_LOCAL_MODE. These tests rely on auto-sign-in and the
 * local API at http://localhost:8002 and will hang or misbehave against
 * a hosted deployment. Keep them isolated from the hosted suite.
 *
 * Start the local stack first:
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *
 * Then:
 *   npx playwright test --config e2e/local/playwright.config.ts
 *
 * Override the frontend URL with E2E_TARGET_URL or the legacy
 * STAGING_URL (both supported for backward compatibility).
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.test\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "../../test-results/e2e-local-report", open: "never" }]],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: "../../test-results/e2e-local-artifacts",

  use: {
    baseURL:
      process.env.E2E_TARGET_URL ||
      process.env.STAGING_URL ||
      "http://localhost:8081",
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      testIgnore: /mobile-personal-walkthrough\.test\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "iphone-15-pro",
      testMatch: /mobile-personal-walkthrough\.test\.ts$/,
      use: {
        ...devices["iPhone 15 Pro"],
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "pixel-7",
      testMatch: /mobile-personal-walkthrough\.test\.ts$/,
      use: {
        ...devices["Pixel 7"],
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
})
