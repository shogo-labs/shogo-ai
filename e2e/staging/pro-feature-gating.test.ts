// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import { homeComposerInput, makeTestUser, signUpAndUpgradeToPro } from "./helpers"

/**
 * Pro Feature Gating E2E Tests
 *
 * Validates that Pro plan features are correctly unlocked after upgrade.
 * Tests the model selector, project header, sidebar, and billing page state.
 *
 * Known bugs documented here (annotated with test.fixme):
 * - Advanced model shows "Upgrade to unlock" even for Pro users
 *   Root cause: _layout.tsx doesn't pass billingData to ChatPanel
 * - "Upgrade" button always visible in project header
 *   Root cause: ProjectTopBar.tsx has no subscription check
 * - "Manage" button is non-functional (portal returns 501)
 *
 * Run: npx playwright test --config e2e/playwright.config.ts pro-feature-gating
 */

const TEST_USER = makeTestUser("Gating")

test.describe("Pro Feature Gating", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndUpgradeToPro(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  // ── Billing Page Gating ──────────────────────────────────────────

  test("billing page shows Pro plan status", async () => {
    await page.goto("/billing")
    await page.waitForSelector("text=Billing", { timeout: 10_000 })

    await expect(page.getByText("You're on Pro Plan")).toBeVisible()
    await expect(page.getByText("Change Plan")).toBeVisible()
    await expect(page.getByText(/\$[\d.]+ of \$[\d.]+/)).toBeVisible()
  })

  // ── Sidebar Gating ───────────────────────────────────────────────

  test("sidebar hides Upgrade CTA for Pro users", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 10_000 })

    // The "Upgrade to Pro" button in the sidebar bottom should be gone
    const upgradeCTA = page.locator("text=Upgrade to Pro")
    await expect(upgradeCTA).not.toBeVisible()
  })

  // ── Model Selector Gating ────────────────────────────────────────

  test("Advanced model is selectable for Pro users", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 15_000 })

    const input = homeComposerInput(page)
    await input.click()
    await input.fill("Test model gating")
    await page.waitForTimeout(500)
    await page.keyboard.press("Enter")
    await page.waitForURL(/\/projects\//, { timeout: 60_000 })

    // Wait for agent to finish streaming — model selector is disabled while streaming
    await page.waitForSelector('[aria-label="Stop"], [aria-label="stop"]', { state: "detached", timeout: 60_000 }).catch(() => {})
    await page.waitForTimeout(500)

    // Model selector button shows current model ("Basic" or "Advanced" for Pro users)
    const modelBtn = page.getByText("Basic", { exact: true }).or(page.getByText("Advanced", { exact: true }).last())
    await expect(modelBtn).toBeVisible({ timeout: 15_000 })
    await modelBtn.last().click()

    // Verify Advanced tier is available (not locked) for Pro users
    await expect(page.getByText("Advanced")).toBeVisible()
    await expect(page.getByText("Upgrade to unlock")).not.toBeVisible()

    await page.getByText("Advanced").last().click()
    await page.waitForTimeout(1_000)
    expect(page.url()).not.toContain("/billing")
  })

  // ── Project Header Gating ────────────────────────────────────────

  test("project header hides Upgrade button for Pro users", async () => {
    // Should still be on the project page from the previous test
    // The "Upgrade" text in the project top bar should not be visible for Pro users
    const upgradeBtn = page.locator("text=Upgrade").first()
    await expect(upgradeBtn).not.toBeVisible({ timeout: 5_000 })
  })

  // ── Manage Subscription ──────────────────────────────────────────

  test("Manage button opens Stripe customer portal", async () => {
    await page.goto("/billing")
    await page.waitForSelector("text=Billing", { timeout: 10_000 })

    await page.getByText("Manage", { exact: true }).click()

    // Portal opens via redirect in the same tab
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 15_000 })
    expect(page.url()).toContain("billing.stripe.com")
  })
})
