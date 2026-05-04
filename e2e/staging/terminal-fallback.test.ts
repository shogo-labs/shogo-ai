// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { test, expect } from '@playwright/test'

test.describe('Terminal HTTP fallback', () => {
  test.skip(!process.env.E2E_PROJECT_URL, 'Set E2E_PROJECT_URL to run against an authenticated staging project')

  test('keeps the legacy prompt available when PTY is disabled', async ({ page }) => {
    await page.goto(process.env.E2E_PROJECT_URL!)
    await page.getByRole('tab', { name: 'Terminal' }).click()
    await expect(page.getByLabel('Command')).toBeVisible()
    await page.getByLabel('Command').fill('echo fallback-ok')
    await page.keyboard.press('Enter')
    await expect(page.getByText('fallback-ok')).toBeVisible({ timeout: 15_000 })
  })
})
