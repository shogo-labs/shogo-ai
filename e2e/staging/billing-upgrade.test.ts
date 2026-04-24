// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import { makeTestUser, signUpAndOnboard, STRIPE_CARDS } from "./helpers"

/**
 * Billing & Upgrade Flow E2E Tests (USD pricing)
 *
 * Tests the complete lifecycle: sign-up → free plan → failed payment →
 * successful upgrade → Pro feature verification → usage tracking in USD.
 *
 * Targets the deployed staging environment (set STAGING_URL env var).
 * Uses Stripe test cards (4000000000000002 for decline, 4242424242424242 for success).
 *
 * Run: npx playwright test --config e2e/playwright.config.ts billing-upgrade
 */

const TEST_USER = makeTestUser("Billing")

async function navigateToBilling(page: Page) {
  await page.goto("/billing")
  // Wait for workspace + billing data — the plan cards only render after
  // useActiveWorkspace and useBillingData have resolved.
  await page.waitForSelector("text=You're on", { timeout: 15_000 })
}

/**
 * Extract the first "$x.xx of $y.yy" pair from the usage card and return
 * [remainingUsd, totalUsd]. Returns null if the page hasn't rendered yet.
 */
async function readUsageCard(
  page: Page,
): Promise<{ remainingUsd: number; totalUsd: number } | null> {
  const el = page.getByText(/\$[\d.,]+ of \$[\d.,]+/).first()
  const text = (await el.textContent().catch(() => null)) ?? ""
  const match = text.match(/\$([\d.,]+)\s+of\s+\$([\d.,]+)/)
  if (!match) return null
  return {
    remainingUsd: parseFloat(match[1].replace(/,/g, "")),
    totalUsd: parseFloat(match[2].replace(/,/g, "")),
  }
}

async function fillStripeCheckout(
  page: Page,
  cardNumber: string,
  opts?: { name?: string; zip?: string },
) {
  const name = opts?.name ?? TEST_USER.name
  const zip = opts?.zip ?? "10001"

  // Wait for navigation to Stripe hosted checkout
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })

  await page.getByPlaceholder("1234 1234 1234 1234").pressSequentially(cardNumber)
  await page.getByPlaceholder("MM / YY").pressSequentially("1228")
  await page.getByPlaceholder("CVC").pressSequentially("123")
  await page.getByPlaceholder("Full name on card").fill(name)
  await page.getByPlaceholder("ZIP").fill(zip)

  // Uncheck "Save my information" to avoid phone number requirement
  const saveCheckbox = page.getByRole("checkbox", {
    name: /Save my information/,
  })
  if (await saveCheckbox.isChecked()) {
    await saveCheckbox.click()
  }
}

// ── Test Suite ───────────────────────────────────────────────────────

test.describe("Billing & Upgrade Flow", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
  })

  test.afterAll(async () => {
    await page.close()
  })

  // ── Phase 1: Sign-Up ────────────────────────────────────────────

  test("sign up creates account and redirects to home", async () => {
    await signUpAndOnboard(page, TEST_USER)

    await expect(page.getByText(/What's on your mind/)).toBeVisible()
    await expect(page.getByText(/Personal/)).toBeVisible()
  })

  // ── Phase 2: Free Plan State ─────────────────────────────────────

  test("free plan: billing page shows correct initial state (USD)", async () => {
    await navigateToBilling(page)

    await expect(page.getByText("You're on Free Plan")).toBeVisible()
    // Free tier: no monthly pool, daily $0.50 resets at UTC midnight.
    await expect(page.getByText(/\$[\d.]+ of \$[\d.]+/)).toBeVisible()
    await expect(
      page.getByText(/Daily allowance is used before your monthly pool|Daily allowance resets at midnight UTC/i),
    ).toBeVisible()
  })

  test("free plan: sidebar shows Upgrade to Pro CTA", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 10_000 })

    await expect(page.getByText("Upgrade to Pro")).toBeVisible()
    await expect(
      page.getByText("Unlock more benefits").or(page.getByText(/of \$[\d.]+ left/)),
    ).toBeVisible()
  })

  test("free plan: three pricing tiers displayed", async () => {
    await navigateToBilling(page)

    await expect(page.getByText("Pro").first()).toBeVisible()
    await expect(page.getByText("$25")).toBeVisible()
    await expect(page.getByText("Business", { exact: true }).first()).toBeVisible()
    await expect(page.getByText("$365")).toBeVisible()
    await expect(page.getByText("Enterprise", { exact: true }).first()).toBeVisible()
    await expect(page.getByText("Custom", { exact: true })).toBeVisible()
  })

  // ── Phase 3: Failed Card ─────────────────────────────────────────

  test("failed card: Stripe shows decline error and stays on form", async () => {
    await navigateToBilling(page)

    const upgradeButtons = page.getByText("Upgrade to Pro")
    await upgradeButtons.last().click()

    await fillStripeCheckout(page, STRIPE_CARDS.decline)

    await page.getByTestId("hosted-payment-submit-button").click()
    await expect(
      page.getByText(/credit card was declined/),
    ).toBeVisible({ timeout: 15_000 })

    expect(page.url()).toContain("checkout.stripe.com")
  })

  // ── Phase 4: Successful Upgrade ──────────────────────────────────

  test("successful card: completes upgrade and redirects to app", async () => {
    const cardInput = page.getByPlaceholder("1234 1234 1234 1234")
    await cardInput.click()
    await cardInput.press("Meta+a")
    await cardInput.press("Backspace")
    await cardInput.pressSequentially(STRIPE_CARDS.success)

    await page.getByTestId("hosted-payment-submit-button").click()

    await page.waitForURL((url) => !url.toString().includes("stripe.com"), {
      timeout: 30_000,
    })
    await page.waitForLoadState("domcontentloaded")
  })

  // ── Phase 5: Post-Upgrade Billing Page ───────────────────────────

  test("post-upgrade: billing page shows Pro Plan", async () => {
    await navigateToBilling(page)

    await expect(page.getByText("You're on Pro Plan")).toBeVisible()
  })

  test("post-upgrade: USD usage pool allocated (monthly + daily)", async () => {
    // Pro tier is $20/month included + $0.50/day daily allowance. The
    // exact total can drift as plans evolve, so just assert that the
    // total is > $20 (i.e. monthly pool is present alongside a daily
    // sliver) and the remaining starts at or near the total.
    const usage = await readUsageCard(page)
    expect(usage).not.toBeNull()
    expect(usage!.totalUsd).toBeGreaterThanOrEqual(20)
    expect(usage!.remainingUsd).toBeGreaterThan(usage!.totalUsd * 0.9)
  })

  test("post-upgrade: Pro card shows Change Plan instead of Upgrade", async () => {
    await expect(page.getByText("Change Plan")).toBeVisible()
  })

  test("post-upgrade: annual toggle available", async () => {
    await expect(page.getByText("Monthly", { exact: true })).toBeVisible()
    await expect(page.getByText("Annual", { exact: true })).toBeVisible()
    await expect(page.getByText("Save ~17%")).toBeVisible()
  })

  // ── Phase 6: Sidebar After Upgrade ───────────────────────────────

  test("post-upgrade: sidebar hides Upgrade to Pro CTA", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 10_000 })

    await expect(page.getByText("Upgrade to Pro")).not.toBeVisible()
  })

  // ── Phase 7: Model Gating ────────────────────────────────────────

  test("post-upgrade: Advanced model is available for Pro users", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 10_000 })

    const input = page.getByPlaceholder("Ask Shogo to ...")
    await input.click()
    await input.fill("Test model gating for Pro plan")
    await page.waitForTimeout(500)
    await page.keyboard.press("Enter")

    await page.waitForURL(/\/projects\//, { timeout: 60_000 })

    await page
      .waitForSelector('[aria-label="Stop"], [aria-label="stop"]', {
        state: "detached",
        timeout: 60_000,
      })
      .catch(() => {})
    await page.waitForTimeout(500)

    const modelBtn = page
      .getByText("Basic", { exact: true })
      .or(page.getByText("Advanced", { exact: true }).last())
    await expect(modelBtn).toBeVisible({ timeout: 10_000 })

    await modelBtn.last().click()

    await expect(page.getByText("Advanced")).toBeVisible()
    await expect(page.getByText("Upgrade to unlock")).not.toBeVisible()
  })

  test("post-upgrade: project header hides Upgrade button for Pro users", async () => {
    const upgradeInHeader = page.locator(
      '[class*="flex-row"][class*="items-center"] >> text=Upgrade',
    )
    await expect(upgradeInHeader).not.toBeVisible()
  })

  // ── Phase 8: Usage Tracking (USD) ────────────────────────────────

  test("post-upgrade: usage deducted after agent interaction", async () => {
    // Wait for the agent to finish responding to the first message
    await page.waitForTimeout(15_000)

    await navigateToBilling(page)

    const usage = await readUsageCard(page)
    expect(usage).not.toBeNull()
    expect(usage!.remainingUsd).toBeLessThan(usage!.totalUsd)
    // A single chat turn should not consume most of the pool.
    expect(usage!.remainingUsd).toBeGreaterThan(usage!.totalUsd * 0.5)
  })

  test("post-upgrade: second interaction further reduces remaining USD", async () => {
    const before = await readUsageCard(page)
    expect(before).not.toBeNull()

    await page.goBack()
    await page.waitForURL(/\/projects\//, { timeout: 30_000 })

    const chatInput = page.getByPlaceholder("Ask Shogo...")
    await chatInput.fill("Add a done column to the tracker")
    await chatInput.press("Enter")

    await page.waitForTimeout(20_000)

    await navigateToBilling(page)
    const after = await readUsageCard(page)
    expect(after).not.toBeNull()
    expect(after!.remainingUsd).toBeLessThan(before!.remainingUsd)
  })

  // ── Phase 9: Manage Subscription ─────────────────────────────────

  test("post-upgrade: Manage button opens Stripe customer portal", async () => {
    await navigateToBilling(page)

    await page.getByText("Manage", { exact: true }).click()
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 15_000 })
    expect(page.url()).toContain("billing.stripe.com")
  })
})
