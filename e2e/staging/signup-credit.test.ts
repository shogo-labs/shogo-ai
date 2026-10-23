// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import {
  makeTestUser,
  signUpAndOnboard,
  signupCreditStateViaBackdoor,
  verifyEmailViaBackdoor,
  type SignupCreditState,
} from "./helpers"

/**
 * Signup credit E2E (staged $2 → $8).
 *
 * Every new cloud signup gets $10 of promo credit, paid out in two stages:
 *   • $2 when the account is created (low risk band, unverified email)
 *   • $8 when the email is verified and the risk re-score still passes
 *
 * Test accounts sign up with the e2e bootstrap header, so the risk scorer
 * allowlists them (score 0, full credit path). Verification goes through the
 * backdoor, which runs the same release path as the real verification hook.
 *
 * Requires SHOGO_E2E_BOOTSTRAP_SECRET. Without it the suite skips.
 *
 * Run: npx playwright test --config e2e/playwright.config.ts signup-credit
 */

const TEST_USER = makeTestUser("Credit")
const BACKDOOR = Boolean(process.env.SHOGO_E2E_BOOTSTRAP_SECRET)

test.describe("Signup credit (staged $2 → $8)", () => {
  test.describe.configure({ mode: "serial" })
  test.skip(!BACKDOOR, "needs SHOGO_E2E_BOOTSTRAP_SECRET to read credit state")

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("signup grants $2 now and holds the rest until email verification", async () => {
    const state = (await signupCreditStateViaBackdoor(page, TEST_USER.email)) as SignupCreditState
    expect(state.ok).toBe(true)
    expect(state.workspaceId).toBeTruthy()

    expect(state.assessment).not.toBeNull()
    expect(state.assessment!.band).toBe("low")
    expect(state.assessment!.decision).toBe("credit_initial")

    expect(state.promoCredit).not.toBeNull()
    expect(state.promoCredit!.availableUsd).toBeCloseTo(2, 2)
    expect(state.promoCredit!.grantedUsd).toBeCloseTo(2, 2)
    expect(state.promoCredit!.stage).toBe(1)

    // Expiry is 30 days out.
    const expiresMs = new Date(state.promoCredit!.expiresAt!).getTime()
    const days = (expiresMs - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(29)
    expect(days).toBeLessThan(31)
  })

  test("billing page shows the free credit and the verify-email prompt", async () => {
    await page.goto("/billing")
    await page.waitForSelector("text=Billing", { timeout: 15_000 })

    await expect(page.getByText(/\$2\.00 free credit left/)).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByText("Verify your email to unlock $8.00 more free credit."),
    ).toBeVisible()
  })

  test("verifying the email releases the remaining $8 (total $10)", async () => {
    const outcome = await verifyEmailViaBackdoor(page, TEST_USER.email)
    expect(outcome).not.toBeNull()
    expect(outcome!.released).toBe(true)
    expect(outcome!.amountUsd).toBe(8)

    const state = (await signupCreditStateViaBackdoor(page, TEST_USER.email)) as SignupCreditState
    expect(state.emailVerified).toBe(true)
    expect(state.assessment!.decision).toBe("credit_released")
    expect(state.promoCredit!.availableUsd).toBeCloseTo(10, 2)
    expect(state.promoCredit!.grantedUsd).toBeCloseTo(10, 2)
    expect(state.promoCredit!.stage).toBe(2)
  })

  test("the verify prompt is gone once the full credit is granted", async () => {
    await page.goto("/billing")
    await page.waitForSelector("text=Billing", { timeout: 15_000 })

    await expect(page.getByText(/\$10\.00 free credit left/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Verify your email to unlock/)).toHaveCount(0)
  })

  test("verification is idempotent: a second verify adds no credit", async () => {
    const again = await verifyEmailViaBackdoor(page, TEST_USER.email)
    expect(again!.released).toBe(false)
    expect(again!.reason).toBe("not_eligible")

    const state = (await signupCreditStateViaBackdoor(page, TEST_USER.email)) as SignupCreditState
    expect(state.promoCredit!.availableUsd).toBeCloseTo(10, 2)
    expect(state.promoCredit!.grantedUsd).toBeCloseTo(10, 2)
  })

  test("workspace-plan exposes the credit to the billing client", async () => {
    const state = (await signupCreditStateViaBackdoor(page, TEST_USER.email)) as SignupCreditState
    const res = await page.request.get(
      `/api/billing/workspace-plan?workspaceId=${state.workspaceId}`,
    )
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.promoCredit.availableUsd).toBeCloseTo(10, 2)
    expect(body.promoCredit.emailVerified).toBe(true)
    expect(body.promoCredit.pendingVerificationUsd).toBe(0)
  })
})
