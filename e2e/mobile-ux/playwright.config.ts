// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.test\.ts$/,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: process.env.E2E_TARGET_URL || "http://localhost:8081",
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "iphone-15-pro",
      use: { ...devices["iPhone 15 Pro"], hasTouch: true, isMobile: true },
    },
    {
      name: "pixel-7",
      use: { ...devices["Pixel 7"], hasTouch: true, isMobile: true },
    },
  ],
});
