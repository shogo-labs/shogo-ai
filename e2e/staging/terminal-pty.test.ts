// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { test, expect } from '@playwright/test'

test.describe('Terminal PTY', () => {
  test.skip(!process.env.E2E_PROJECT_URL, 'Set E2E_PROJECT_URL to run against an authenticated staging project')

  test('renders a PTY terminal and accepts interactive input', async ({ page }) => {
    await page.goto(process.env.E2E_PROJECT_URL!)
    await page.getByRole('tab', { name: 'Terminal' }).click()
    await expect(page.getByLabel('Terminal output')).toBeVisible()
    await page.keyboard.type('echo pty-ok')
    await page.keyboard.press('Enter')
    await expect(page.getByText('pty-ok')).toBeVisible({ timeout: 15_000 })
  })
})
