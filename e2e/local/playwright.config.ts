// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { resolve } from "path"
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
 *
 * `E2E_LOCAL_START_STACK=1` (PR CI) makes Playwright boot the stack itself:
 * a throwaway SQLite DB, the local-mode API on :8002 and Expo web on :8081
 * (override with E2E_LOCAL_WEB_PORT).
 */
const startStack = process.env.E2E_LOCAL_START_STACK === "1"
const webPort = process.env.E2E_LOCAL_WEB_PORT || "8081"
const webUrl = `http://localhost:${webPort}`
// Some specs default to a developer's API port; point them at the stack's.
if (startStack) process.env.E2E_API_URL = "http://localhost:8002"
const repoRoot = resolve(__dirname, "../..")
const localDbPath = resolve(repoRoot, "test-results/e2e-local.db")
const localEnv = {
  SHOGO_LOCAL_MODE: "true",
  DATABASE_URL: `file:${localDbPath}`,
  BETTER_AUTH_SECRET: "e2e-local-secret",
  BETTER_AUTH_URL: "http://localhost:8002",
  NODE_ENV: "development",
  EXPO_PUBLIC_LOCAL_MODE: "true",
  API_PORT: "8002",
  EXPO_PUBLIC_API_PORT: "8002",
  EXPO_PUBLIC_API_URL: "http://localhost:8002",
  // A developer's apps/mobile/.env.local otherwise wins over the values above.
  EXPO_NO_DOTENV: "1",
  // Every spec shares one local user and IP, so the suite trips the default
  // 600/min global limit partway through.
  RATE_LIMIT_GLOBAL_MAX: "100000",
  BROWSER: "none",
  ...(process.env.CI ? { CI: "true" } : {}),
}

export default defineConfig({
  ...(startStack
    ? {
        webServer: [
          {
            command:
              `rm -f "${localDbPath}" && ` +
              `bun x prisma db push --schema=prisma/schema.local.prisma --url "file:${localDbPath}" --accept-data-loss && ` +
              "bun --no-env-file apps/api/src/entry.ts",
            cwd: repoRoot,
            env: localEnv,
            url: "http://localhost:8002/api/health",
            timeout: 180_000,
            reuseExistingServer: !process.env.CI,
            stdout: "pipe",
          },
          {
            // --clear: Metro caches inlined EXPO_PUBLIC_* values, which would
            // otherwise keep pointing at a developer's .env.local API port.
            command: `bun run --cwd apps/mobile dev:web -- --port ${webPort} --clear`,
            cwd: repoRoot,
            env: localEnv,
            url: webUrl,
            timeout: 300_000,
            reuseExistingServer: !process.env.CI,
          },
        ],
      }
    : {}),
  globalSetup: resolve(__dirname, "global-setup.ts"),
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
      webUrl,
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
