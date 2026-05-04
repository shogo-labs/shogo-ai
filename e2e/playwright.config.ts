// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig, devices } from "@playwright/test"

/**
 * Playwright E2E config for hosted-environment tests.
 *
 * Point `E2E_TARGET_URL` at the environment you want to validate
 * (staging, production, a preview deployment, …). The legacy
 * `STAGING_URL` env var is still honored so existing CI jobs keep
 * working while they migrate.
 *
 * Run:
 *   E2E_TARGET_URL=https://studio.staging.shogo.ai \
 *     npx playwright test --config e2e/playwright.config.ts
 *   npx playwright test --config e2e/playwright.config.ts --ui
 *
 * Production runs additionally honor `E2E_STRIPE_MODE=live|test` so
 * that tests which drive Stripe hosted Checkout with a test card can
 * be skipped cleanly when pointed at live keys. See
 * e2e/staging/helpers.ts → isLiveStripeEnv().
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
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
