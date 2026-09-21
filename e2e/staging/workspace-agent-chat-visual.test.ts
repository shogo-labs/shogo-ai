// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, test, type Page } from '@playwright/test'
import { makeTestUser, signUpAndOnboard, type TestUser } from './helpers'

/**
 * Tagged desktop visual baselines for the staged Workspace Agent Chat rollout.
 *
 * Run against a target explicitly configured with `agentShell=true` and
 * workspace runtimes available:
 *   E2E_AGENT_SHELL=true E2E_TARGET_URL=... \
 *   npx playwright test --config e2e/playwright.config.ts workspace-agent-chat-visual
 *
 * Generate accepted images with `--update-snapshots`; filenames deliberately
 * keep the Muse reference tag used during visual review.
 */
const AGENT_SHELL_ENABLED = process.env.E2E_AGENT_SHELL === 'true'
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
  test.skip(!AGENT_SHELL_ENABLED, 'requires an explicit agentShell-enabled E2E target')

  test('MUSE-REF-ONBOARDING-CHAT — 1618×948', async ({ page }) => {
    await page.setViewportSize({ width: 1618, height: 948 })
    await openWorkspaceAgentChat(page, TEST_USER)
    await expect(page).toHaveScreenshot('MUSE-REF-ONBOARDING-CHAT-1618x948.png', {
      fullPage: true,
    })
  })

  test('MUSE-REF-SESSION-CONTEXT — 1440×900', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openWorkspaceAgentChat(page, TEST_USER)
    await expect(page).toHaveScreenshot('MUSE-REF-SESSION-CONTEXT-1440x900.png', {
      fullPage: true,
    })
  })

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
