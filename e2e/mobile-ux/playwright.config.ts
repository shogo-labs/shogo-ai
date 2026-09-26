// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig, devices } from "@playwright/test";

/**
 * Mobile-viewport UX walkthrough for the local web build of the native
 * mobile experience. This deliberately uses real browser input and touch
 * emulation so the same React Native Web surfaces are exercised end to end.
 *
 * Start the local stack first:
 *   SHOGO_LOCAL_MODE=true bun run api:dev
 *   SHOGO_LOCAL_MODE=true bun run web:dev
 *
 * Then:
 *   npx playwright test --config e2e/mobile-ux/playwright.config.ts
 */
export default defineConfig({
  testDir: ".",
  testMatch: /personal-walkthrough\.test\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: "../../test-results/e2e-mobile-ux-report",
        open: "never",
      },
    ],
  ],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: "../../test-results/e2e-mobile-ux-artifacts",
  use: {
    baseURL:
      process.env.E2E_TARGET_URL ||
      process.env.STAGING_URL ||
      "http://localhost:8081",
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: "iphone-15-pro",
      use: {
        ...devices["iPhone 15 Pro"],
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "pixel-7",
      use: {
        ...devices["Pixel 7"],
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
