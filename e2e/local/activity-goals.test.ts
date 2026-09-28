// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, test, type Page } from '@playwright/test'

const API_BASE = process.env.E2E_API_URL || 'http://localhost:8002'

async function openWorkspaceMenu(page: Page): Promise<boolean> {
  await page.goto('/')
  await page.evaluate(async (apiBase) => {
    await fetch(`${apiBase}/api/local/auto-sign-in`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => {})
  }, API_BASE)
  await page.goto('/')
  await page.waitForTimeout(2_000)
  if (await page.getByText('Getting started', { exact: true }).isVisible().catch(() => false)) {
    await page.goto('/sign-in')
    await page.waitForTimeout(3_000)
    await page.goto('/')
    await page.waitForTimeout(2_000)
  }
  if (await page.getByText('Getting started', { exact: true }).isVisible().catch(() => false)) {
    // Local-mode databases can be fresh even though auto-sign-in succeeded.
    // Complete the non-product-specific onboarding gate so this suite can
    // exercise the workspace surfaces themselves.
    await page.evaluate(async (apiBase) => {
      await fetch(`${apiBase}/api/onboarding/complete`, {
        method: 'POST',
        credentials: 'include',
      }).catch(() => {})
    }, API_BASE)
    await page.goto('/')
    await page.waitForTimeout(2_000)
  }
  const trigger = page.getByRole('button', { name: /— open account/ })
  if (!(await trigger.isVisible().catch(() => false))) return false
  await trigger.click()
  if (!(await page.getByText(/all workspaces/i, { exact: true }).isVisible().catch(() => false))) return false
  // Workspace membership loads independently of the account popover shell.
  // Give the list a moment to converge before selecting by kind.
  await page.waitForTimeout(1_000)
  return true
}

async function selectWorkspaceKind(page: Page, kind: 'Personal' | 'Team'): Promise<boolean> {
  if (!(await openWorkspaceMenu(page))) return false
  const badge = page.getByText(kind, { exact: true }).last()
  if (!(await badge.isVisible().catch(() => false))) return false

  // The badge is inside the workspace row's Pressable. Clicking the row is
  // more reliable across react-native-web than clicking the small badge text.
  await badge.locator('..').locator('..').click()
  await page.waitForTimeout(500)
  return true
}

test.describe('Activity and Goals workspace surfaces (local mode)', () => {
  test('team workspace shows Activity and redirects Goals away', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const selected = await selectWorkspaceKind(page, 'Team')
    test.skip(!selected, 'local test environment does not expose a team workspace')

    await page.goto('/activity')
    await expect(page.getByText('Activity', { exact: true }).last()).toBeVisible()
    await expect(page.getByText('Workspace overview', { exact: true })).toBeVisible({
      timeout: 15_000,
    })

    await page.goto('/goals')
    await expect(page).toHaveURL(/\/(?:\?|$)/, { timeout: 15_000 })
    await expect(page.getByText('Workspace overview', { exact: true }).or(
      page.getByText('Chat', { exact: true }).first(),
    )).toBeVisible({ timeout: 15_000 })
  })

  test('personal workspace shows Activity and Goals', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const selected = await selectWorkspaceKind(page, 'Personal')
    test.skip(!selected, 'local test environment does not expose a personal workspace')

    await page.goto('/activity')
    await expect(page.getByText('Activity', { exact: true }).last()).toBeVisible()
    await expect(page.getByText(/Nothing here yet|Happening now|Needs your OK/).first()).toBeVisible({
      timeout: 15_000,
    })

    await page.goto('/goals')
    await expect(page.getByText('Goals', { exact: true }).last()).toBeVisible()
    await expect(page.getByText(/No goals yet|In progress|Paused and complete|Needs your OK/).first()).toBeVisible({
      timeout: 15_000,
    })
  })
})

