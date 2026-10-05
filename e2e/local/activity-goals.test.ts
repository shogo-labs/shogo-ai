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
  // Desktop rows are tagged Local/Cloud rather than by kind, so find the
  // local workspace of that kind by name.
  const name = await page.evaluate(async ({ apiBase, kind }) => {
    const res = await fetch(`${apiBase}/api/workspaces`, { credentials: 'include' }).catch(() => null)
    const body = res ? await res.json().catch(() => null) : null
    const items = (body?.items ?? body?.data?.items ?? []) as Array<{ name: string; kind: string; source?: string }>
    return items.find((w) => w.kind === kind.toLowerCase() && w.source !== 'cloud')?.name ?? null
  }, { apiBase: API_BASE, kind })
  if (!name) return false
  const label = page.getByText(name, { exact: true }).last()
  if (!(await label.isVisible().catch(() => false))) return false

  // Clicking the row is more reliable across react-native-web than the text.
  await label.locator('..').click()
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
    // Back on Home: the rail's Home tab is selected.
    await expect(
      page.getByRole('navigation', { name: 'Workspace tabs' }).getByRole('tab', { name: /^Home/ }),
    ).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
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

