// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig, devices } from "@playwright/test"
import { criticalPathTestMatch } from "./staging/critical-path"
import { quarantineGrepInvert } from "./staging/quarantine"

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

const CRITICAL_SUITE_WORKER_CAP = 4

/**
 * Worker count, bounded by what the target cluster can absorb (SHO-136).
 *
 * Every hosted file provisions its own isolated account and project runtime, so
 * an uncached boot pulls the ~10 GB `shogo-runtime` image onto whichever node
 * the scheduler picks. An 8-worker critical run could want ~80 GB across three
 * staging nodes — that is the load that put a node under DiskPressure on
 * 2026-10-21 and timed out whichever specs landed there.
 *
 * The critical suite therefore never exceeds 4 workers: `E2E_WORKERS` can dial
 * it DOWN, never up. The full nightly suite keeps 8 (off-peak, and it is the
 * suite that actually needs the throughput).
 */
export function resolveWorkers(env: Record<string, string | undefined>): number {
  const requested = Number(env.E2E_WORKERS)
  const override = Number.isFinite(requested) && requested > 0 ? requested : undefined
  if (env.E2E_SUITE === 'critical') {
    return Math.min(override ?? CRITICAL_SUITE_WORKER_CAP, CRITICAL_SUITE_WORKER_CAP)
  }
  if (override) return override
  return env.CI ? 8 : 1
}

export default defineConfig({
  testDir: "./staging",
  ...(process.env.E2E_SUITE === "critical" ? { testMatch: criticalPathTestMatch() } : {}),
  grepInvert: process.env.E2E_INCLUDE_QUARANTINED === "1" ? undefined : quarantineGrepInvert(),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: resolveWorkers(process.env),
  reporter: [
    ["html", { outputFolder: "../test-results/e2e-report" }],
    // Machine-readable copy for the environment/product classification
    // (scripts/e2e-classify.ts) and the per-spec durations in the run summary.
    ["json", { outputFile: "../test-results/e2e-report.json" }],
  ],
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
