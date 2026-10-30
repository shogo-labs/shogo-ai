// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { resolve } from "path"
import { defineConfig, devices } from "@playwright/test"

/**
 * SHO-257 — the cloud studio UI on a paired machine's workspace, against real
 * processes: the cloud API on Postgres + Redis, a desktop paired to it, and the
 * studio web build served in front of the cloud
 * (`apps/api/src/__tests__/helpers/machine-vm-stack.ts`).
 *
 *   (cd apps/mobile && bun run build)        # the cloud web build, once
 *   CHANNELS_TEST_PG_URL=postgresql://… TEST_REDIS_URL=redis://… \
 *     npx playwright test --config e2e/machine-vm/playwright.config.ts
 */
const repoRoot = resolve(__dirname, "../..")
const webPort = process.env.E2E_MACHINE_VM_WEB_PORT || "8093"
export const STATE_FILE = resolve(repoRoot, "test-results/machine-vm-stack.json")

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.test\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { outputFolder: "../../test-results/machine-vm-report", open: "never" }]],
  outputDir: "../../test-results/machine-vm-artifacts",
  webServer: {
    command: "bun --no-env-file apps/api/src/__tests__/helpers/machine-vm-stack.ts",
    cwd: repoRoot,
    url: `http://127.0.0.1:${webPort}/__stack/state`,
    timeout: 480_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      E2E_MACHINE_VM_WEB_PORT: webPort,
      E2E_MACHINE_VM_STATE: STATE_FILE,
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
})
