// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * E2E Test Setup
 *
 * Utilities for setting up and tearing down test state.
 */

import { test as base, expect } from '@playwright/test'

// Test user credentials
export const TEST_USER = {
  email: `test-${Date.now()}@example.com`,
  password: 'TestPassword123!',
  name: 'Test User',
}

// Extend base test with custom fixtures
export const test = base.extend<{
  authenticatedPage: typeof base
}>({
  // Add any custom fixtures here
})

export { expect }

/**
 * Generate unique test email
 */
export function generateTestEmail(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
}

/**
 * Wait for network to be idle
 */
export async function waitForNetworkIdle(page: import('@playwright/test').Page) {
  await page.waitForLoadState('networkidle')
}

/**
 * Clear local storage (for auth state)
 */
export async function clearAuthState(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    localStorage.clear()
  })
}
