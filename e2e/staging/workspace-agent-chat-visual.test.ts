// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, test, type Page } from '@playwright/test'
import { makeTestUser, signUpAndOnboard, type TestUser } from './helpers'

/**
 * Tagged mobile visual baselines for the staged Workspace Agent Chat rollout.
 *
 * Run against a target with a personal workspace and workspace runtimes
 * available:
 *   E2E_MOBILE_AGENT_SHELL=true E2E_TARGET_URL=... \
 *   npx playwright test --config e2e/playwright.config.ts workspace-agent-chat-visual
 *
 * `E2E_MOBILE_AGENT_SHELL` only opts this visual suite in; it does not
 * configure the target's mobile shell.
 *
 * Generate accepted images with `--update-snapshots`; filenames deliberately
 * keep the Muse reference tag used during visual review.
 */
const MOBILE_VISUALS_ENABLED =
  process.env.E2E_MOBILE_AGENT_SHELL === 'true'
const TEST_USER: TestUser = makeTestUser('WorkspaceAgentChatVisual')

async function openWorkspaceAgentChat(page: Page, user: TestUser) {
  await page.goto('/')
  const chat = page.getByText('Workspace Agent Chat', { exact: true }).first()
  const signUp = page.getByRole('tab', { name: 'Sign Up' })
  await Promise.race([
    chat.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {}),
    signUp.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {}),
  ])
  if (!(await chat.isVisible().catch(() => false))) {
    await signUpAndOnboard(page, user)
    await chat.waitFor({ state: 'visible', timeout: 60_000 })
  }
}

test.describe('Workspace Agent Chat Muse visual baselines', () => {
  test.skip(
    !MOBILE_VISUALS_ENABLED,
    'requires an explicitly enabled mobile visual E2E run',
  )

  test('MUSE-MOBILE-REF-CHAT-COMPOSER — 430×932', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await openWorkspaceAgentChat(page, TEST_USER)
    await expect(page).toHaveScreenshot('MUSE-MOBILE-REF-CHAT-COMPOSER-430x932.png', {
      fullPage: true,
    })
  })

  test('MUSE-MOBILE-REF-SESSION-DRAWER — 390×844', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openWorkspaceAgentChat(page, TEST_USER)
    await page.getByLabel('Open chat sessions').click()
    await expect(page).toHaveScreenshot('MUSE-MOBILE-REF-SESSION-DRAWER-390x844.png', {
      fullPage: true,
    })
  })
})
