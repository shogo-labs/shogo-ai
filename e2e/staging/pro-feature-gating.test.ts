// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"

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

const TEST_USER = {
  name: `E2E Gating ${Date.now()}`,
  email: `e2e-gating-${Date.now()}@mailnull.com`,
  password: "E2EGatingTest2026!",
}

async function signUpAndUpgrade(page: Page) {
  // Sign up
  await page.goto("/sign-in")
  await page.getByText("Sign Up").click()
  await page.getByPlaceholder("Enter your name").fill(TEST_USER.name)
  await page.getByPlaceholder("you@example.com").fill(TEST_USER.email)
  await page.getByPlaceholder("Create a password").fill(TEST_USER.password)
  await page.getByRole("button", { name: "Sign Up" }).or(page.getByText("Sign Up").last()).click()
  // Handle onboarding screen if present (new users see "Get Started" before home)
  const getStarted = page.getByText("Get Started")
  try {
    await getStarted.waitFor({ timeout: 5_000 })
    await getStarted.click()
  } catch {
    // No onboarding screen — already on home
  }
  await page.waitForSelector("text=What's on your mind", { timeout: 20_000 })

  // Upgrade to Pro
  await page.goto("/billing")
  await page.waitForSelector("text=Billing", { timeout: 10_000 })
  await page.getByText("Upgrade to Pro").last().click()
  await page.waitForSelector("text=Subscribe to Pro", { timeout: 15_000 })

  await page.getByPlaceholder("1234 1234 1234 1234").pressSequentially("4242424242424242")
  await page.getByPlaceholder("MM / YY").pressSequentially("1228")
  await page.getByPlaceholder("CVC").pressSequentially("123")
  await page.getByPlaceholder("Full name on card").fill(TEST_USER.name)
  await page.getByPlaceholder("ZIP").fill("10001")

  const saveCheckbox = page.getByRole("checkbox", { name: /Save my information/ })
  if (await saveCheckbox.isChecked()) await saveCheckbox.click()

  await page.getByTestId("hosted-payment-submit-button").click()
  await page.waitForURL("**/studio-staging.shogo.ai/**", { timeout: 30_000 })
}

test.describe("Pro Feature Gating", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndUpgrade(page)
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
    await expect(page.getByText(/105 of 105/)).toBeVisible()
    await expect(page.getByText("Credits will rollover")).toBeVisible()
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

    const input = page.getByPlaceholder("Describe the agent you want to build")
    await input.click()
    await input.fill("Test model gating")
    await page.waitForTimeout(500)
    await page.keyboard.press("Enter")
    await page.waitForURL(/\/projects\//, { timeout: 60_000 })

    await page.waitForSelector("text=Basic", { timeout: 15_000 })
    await page.getByText("Basic").click()

    await expect(page.getByText("Agent Mode")).toBeVisible()
    await expect(page.getByText("Advanced")).toBeVisible()
    await expect(page.getByText("Upgrade to unlock")).not.toBeVisible()

    await page.getByText("Advanced").click()
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
