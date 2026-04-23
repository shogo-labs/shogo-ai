// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Playwright config for the Electron-based notetaker end-to-end test.
 *
 * This is separate from the top-level `e2e/playwright.config.ts` (which
 * targets the hosted Next/Expo web app) because we spin up our own Electron
 * binary here rather than driving a browser.
 *
 * Run:
 *   npx playwright test --config apps/desktop/e2e/playwright.config.ts
 *   npx playwright test --config apps/desktop/e2e/playwright.config.ts --ui
 */
import { defineConfig } from '@playwright/test'
import path from 'path'

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: path.join(__dirname, '..', '..', '..', 'test-results', 'notetaker-e2e'),
  use: {
    trace: 'retain-on-failure',
  },
})
