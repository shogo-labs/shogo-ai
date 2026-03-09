// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig, devices } from "@playwright/test"

/**
 * Playwright config for local dev environment tests.
 *
 * These tests run against the local Expo Web dev server (http://localhost:8081)
 * and exercise the canvas visual editor on the dev preview route.
 *
 * Prerequisites:
 *   bun run web:dev  (Expo web server on port 8081)
 *
 * Run with:
 *   npx playwright test --config e2e/dev/playwright.config.ts
 *   npx playwright test --config e2e/dev/playwright.config.ts --ui
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "../../test-results/e2e-dev-report" }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "../../test-results/e2e-dev-artifacts",

  use: {
    baseURL: "http://localhost:8081",
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
