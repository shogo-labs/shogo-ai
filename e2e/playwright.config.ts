// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig, devices } from "@playwright/test"

/**
 * Playwright E2E config for staging environment tests.
 *
 * These tests run against the deployed staging environment (studio-staging.shogo.ai)
 * and exercise real user flows including sign-up, billing, upgrade, and feature gating.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.config.ts
 *   npx playwright test --config e2e/playwright.config.ts --ui
 */
export default defineConfig({
  testDir: "./staging",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: [["html", { outputFolder: "../test-results/e2e-report" }]],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: "../test-results/e2e-artifacts",

  use: {
    baseURL: process.env.STAGING_URL || "https://studio-staging.shogo.ai",
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
