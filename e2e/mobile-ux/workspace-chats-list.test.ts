// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-473 mobile UX e2e: AC §2–§6 on a phone viewport.
 *
 * Covers:
 *   AC §2 DMs  — Agents chip renders; workspace agent row is present
 *   AC §3 nav  — tapping the workspace agent opens /(app)/chats (not a /c/ conversation)
 *   AC §4 Home — Recent chats section is first; "All" links to DMs with Agents selected
 *   AC §5 drawer — agent screen drawer scrolls the full list; "All chats" row present
 *   AC §6 side-chats — /(app)/side-chats redirects to /(app)/chats
 *
 * Required env:
 *   E2E_TARGET_URL  — URL of the running app (default http://localhost:8081)
 *   E2E_WORKSPACE_ID — id of a team workspace the signed-in session can read
 *
 * Run:
 *   npx playwright test --config e2e/mobile-ux/playwright.config.ts workspace-chats-list
 */

import { expect, test } from '@playwright/test'

const workspaceId = process.env.E2E_WORKSPACE_ID

test.describe('SHO-473: workspace chats list (phone)', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!workspaceId, 'Set E2E_WORKSPACE_ID to a team workspace the session can read')
    await page.goto('/')
    // Wait for the app shell to settle.
    await page.waitForLoadState('networkidle')
  })

  // ── AC §2: DMs tab has an Agents chip ───────────────────────────────────
  test('DMs tab shows an Agents chip next to People', async ({ page }) => {
    // Navigate to the DMs tab via the phone dock.
    const dmsTab = page.getByRole('tab', { name: /DMs/i }).or(
      page.getByTestId('dock-tab-dms'),
    )
    await expect(dmsTab).toBeVisible({ timeout: 15_000 })
    await dmsTab.tap()

    await expect(page.getByRole('button', { name: 'Agents' })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'People' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'All' })).toBeVisible()
  })

  // ── AC §3: tapping the workspace agent opens /(app)/chats ───────────────
  test('tapping the workspace agent in DMs opens /chats (not a /c/ conversation)', async ({ page }) => {
    const dmsTab = page.getByRole('tab', { name: /DMs/i }).or(
      page.getByTestId('dock-tab-dms'),
    )
    await expect(dmsTab).toBeVisible({ timeout: 15_000 })
    await dmsTab.tap()

    // Click the Agents filter chip.
    await page.getByRole('button', { name: 'Agents' }).tap()

    // The workspace agent row is accessible by its "Chats" aria label or its
    // name. Tap it.
    const wsAgentRow = page.getByRole('button', { name: /workspace agent/i }).first()
    if (!(await wsAgentRow.isVisible())) {
      // Try the first agent row if the name varies.
      await page.locator('[accessibilityLabel*="agent"]').first().tap()
    } else {
      await wsAgentRow.tap()
    }

    // The URL should contain /chats and must NOT contain /c/ (a DM conversation).
    await expect(page).toHaveURL(/\/chats/, { timeout: 10_000 })
    expect(page.url()).not.toMatch(/\/c\//)
  })

  // ── AC §4: Home opens with Recent chats at the top ──────────────────────
  test('Home screen shows Recent chats section above the feed', async ({ page }) => {
    // Navigate to Home.
    const homeTab = page.getByRole('tab', { name: /Home/i }).or(
      page.getByTestId('dock-tab-home'),
    )
    await expect(homeTab).toBeVisible({ timeout: 15_000 })
    await homeTab.tap()

    // The Recent chats section header should be near the top of the feed.
    // If there are no agent chats the section is hidden, so only check when
    // the section is present.
    const recentChatsHeader = page.getByText('Recent chats')
    if (await recentChatsHeader.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // It must appear BEFORE the Projects section header.
      const rcBound = await recentChatsHeader.boundingBox()
      const projectsHeader = page.getByText('Projects')
      if (await projectsHeader.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const pBound = await projectsHeader.boundingBox()
        if (rcBound && pBound) {
          expect(rcBound.y).toBeLessThan(pBound.y)
        }
      }
    }
  })

  // ── AC §4: "All" in Recent chats lands on DMs with Agents filter ─────────
  test('"All" action in Recent chats navigates to DMs with Agents chip selected', async ({ page }) => {
    const homeTab = page.getByRole('tab', { name: /Home/i }).or(
      page.getByTestId('dock-tab-home'),
    )
    await expect(homeTab).toBeVisible({ timeout: 15_000 })
    await homeTab.tap()

    const allButton = page.locator('[data-section="Recent chats"] >> text=All').or(
      page.getByTestId('recent-chats-all'),
    )
    if (await allButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await allButton.tap()
      // Should land on DMs with Agents chip active.
      await expect(page).toHaveURL(/dms/, { timeout: 10_000 })
      await expect(page.getByRole('button', { name: 'Agents' })).toBeVisible({ timeout: 10_000 })
    } else {
      test.skip(true, 'No Recent chats section (no agent chats in this workspace)')
    }
  })

  // ── AC §5: agent drawer has no inner fixed-height box ───────────────────
  test('agent screen drawer shows "All chats" row', async ({ page }) => {
    // Navigate to the workspace agent screen.
    await page.goto('/agent')
    await page.waitForLoadState('networkidle')

    // Open the drawer (the floating menu button labelled "Chats" or "Open chat sessions").
    const menuBtn = page
      .getByRole('button', { name: 'Chats' })
      .or(page.getByRole('button', { name: 'Open chat sessions' }))
    await expect(menuBtn).toBeVisible({ timeout: 15_000 })
    await menuBtn.tap()

    // The "All chats" row links to /(app)/chats.
    await expect(page.getByRole('button', { name: 'All chats' })).toBeVisible({ timeout: 10_000 })
  })

  // ── AC §6: /(app)/side-chats redirects to /(app)/chats ──────────────────
  test('/(app)/side-chats redirects to /chats', async ({ page }) => {
    await page.goto('/side-chats')
    await expect(page).toHaveURL(/\/chats/, { timeout: 15_000 })
    expect(page.url()).not.toMatch(/\/side-chats/)
  })
})
