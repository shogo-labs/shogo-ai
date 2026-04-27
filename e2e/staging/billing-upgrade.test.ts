// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import { makeTestUser, signUpAndOnboard } from "./helpers"

/**
 * Billing & Upgrade Flow E2E Tests (USD pricing)
 *
 * Verifies the user-facing billing migration to USD pricing:
 *   • sign-up → free plan landing
 *   • free-plan billing page (USD pool, daily allowance copy)
 *   • sidebar Upgrade-to-Pro CTA
 *   • Pro/Business/Enterprise pricing tiers
 *   • upgrade button reaches Stripe Checkout
 *
 * Stripe Checkout's Adaptive-Pricing UI now leads with a payment-method
 * picker (Link, Amazon Pay, Card, Cash App Pay, Klarna, Bank). The Card
 * radio doesn't reliably react to programmatic Playwright clicks, so the
 * post-upgrade test cases are skipped until the Checkout interaction is
 * automated (or replaced with a direct Stripe API subscription bootstrap).
 *
 * Targets the deployed staging environment (set STAGING_URL env var).
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
      page
        .getByText(/Daily allowance is used before your monthly pool/i)
        .or(page.getByText(/Daily allowance resets at midnight UTC/i))
        .first(),
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

  // ── Phase 3: Stripe Checkout (Reach-Only) ────────────────────────
  //
  // Stripe Checkout's Adaptive-Pricing UI now leads with a payment-method
  // picker (Link, Amazon Pay, Card, Cash App Pay, Klarna, Bank) where the
  // card-number form only renders after the "Card" radio is selected. The
  // radio doesn't reliably react to programmatic Playwright clicks, so we
  // verify only that the upgrade button reaches Stripe Checkout and skip
  // the actual form-fill flow. Manual QA covers the full purchase path.

  test("upgrade button redirects to Stripe Checkout", async () => {
    await navigateToBilling(page)

    const upgradeButtons = page.getByText("Upgrade to Pro")
    await upgradeButtons.last().click()

    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })
    expect(page.url()).toContain("checkout.stripe.com")

    await expect(page.getByText("Subscribe to Pro")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("$25.00")).toBeVisible()
  })

  // ── Phase 4: Post-Upgrade UI (skipped) ───────────────────────────
  //
  // The remaining post-upgrade assertions require a Pro subscription to be
  // created. Re-enable these tests once the Stripe Checkout interaction is
  // automated via a Playwright-friendly UI or replaced with a direct
  // Stripe API subscription bootstrap.

  test.skip("post-upgrade: billing page shows Pro Plan", async () => {
    await navigateToBilling(page)

    await expect(page.getByText("You're on Pro Plan")).toBeVisible()
  })

  test.skip("post-upgrade: USD usage pool allocated (monthly + daily)", async () => {
    // Pro tier is $20/month included + $0.50/day daily allowance. The
    // exact total can drift as plans evolve, so just assert that the
    // total is > $20 (i.e. monthly pool is present alongside a daily
    // sliver) and the remaining starts at or near the total.
    const usage = await readUsageCard(page)
    expect(usage).not.toBeNull()
    expect(usage!.totalUsd).toBeGreaterThanOrEqual(20)
    expect(usage!.remainingUsd).toBeGreaterThan(usage!.totalUsd * 0.9)
  })

  test.skip("post-upgrade: Pro card shows Change Plan instead of Upgrade", async () => {
    await expect(page.getByText("Change Plan")).toBeVisible()
  })

  test.skip("post-upgrade: annual toggle available", async () => {
    await expect(page.getByText("Monthly", { exact: true })).toBeVisible()
    await expect(page.getByText("Annual", { exact: true })).toBeVisible()
    await expect(page.getByText("Save ~17%")).toBeVisible()
  })

  // ── Phase 6: Sidebar After Upgrade ───────────────────────────────

  test.skip("post-upgrade: sidebar hides Upgrade to Pro CTA", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 10_000 })

    await expect(page.getByText("Upgrade to Pro")).not.toBeVisible()
  })

  // ── Phase 7: Model Gating ────────────────────────────────────────

  test.skip("post-upgrade: Advanced model is available for Pro users", async () => {
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

  test.skip("post-upgrade: project header hides Upgrade button for Pro users", async () => {
    const upgradeInHeader = page.locator(
      '[class*="flex-row"][class*="items-center"] >> text=Upgrade',
    )
    await expect(upgradeInHeader).not.toBeVisible()
  })

  // ── Phase 8: Usage Tracking (USD) ────────────────────────────────

  test.skip("post-upgrade: usage deducted after agent interaction", async () => {
    // Wait for the agent to finish responding to the first message
    await page.waitForTimeout(15_000)

    await navigateToBilling(page)

    const usage = await readUsageCard(page)
    expect(usage).not.toBeNull()
    expect(usage!.remainingUsd).toBeLessThan(usage!.totalUsd)
    // A single chat turn should not consume most of the pool.
    expect(usage!.remainingUsd).toBeGreaterThan(usage!.totalUsd * 0.5)
  })

  test.skip("post-upgrade: second interaction further reduces remaining USD", async () => {
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

  test.skip("post-upgrade: Manage button opens Stripe customer portal", async () => {
    await navigateToBilling(page)

    await page.getByText("Manage", { exact: true }).click()
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 15_000 })
    expect(page.url()).toContain("billing.stripe.com")
  })
})
