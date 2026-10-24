// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import {
  bootstrapApiBase,
  bootstrapTrialSubscriptionViaApi,
  isLiveStripeEnv,
  makeTestUser,
  signUpAndOnboard,
  signupCreditStateViaBackdoor,
  type SignupCreditState,
} from "./helpers"

/**
 * 7-day free trial E2E.
 *
 * A free workspace can start a 7-day trial on Basic, Pro or Business. The
 * card is required up front ($0 today), and the subscription auto-charges when
 * the trial ends. Once a workspace has a subscription, the trial CTA is gone.
 *
 * Covers:
 *   • trial CTA shown on each eligible plan card
 *   • the CTA redirects to Stripe Checkout (test mode only)
 *   • a trialing subscription shows the trial end date, hides the CTA, and
 *     allocates only the free wallet (no monthly allowance until a paid invoice)
 *
 * The one-trial-per-card rule runs on Stripe webhooks, which this suite does
 * not drive. It is covered by the API unit tests (trial.service.test.ts).
 *
 * Run: npx playwright test --config e2e/playwright.config.ts billing-trial
 */

const TEST_USER = makeTestUser("Trial")
const LIVE = isLiveStripeEnv()

async function navigateToBilling(page: Page) {
  await page.goto("/billing")
  await page.waitForSelector("text=You're on", { timeout: 15_000 })
}

test.describe("7-day free trial", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("free workspace sees the 7-day trial CTA on Basic, Pro and Business", async () => {
    await navigateToBilling(page)

    for (const plan of ["basic", "pro", "business"] as const) {
      const card = page.getByTestId(`plan-card-${plan}`)
      await expect(card).toBeVisible()
      await expect(card.getByText("Start 7-day free trial")).toBeVisible()
      await expect(card.getByText("$0 today. Card required; cancel anytime.")).toBeVisible()
    }
  })

  test("enterprise has no trial CTA", async () => {
    await navigateToBilling(page)
    await expect(page.getByTestId("plan-card-enterprise").getByText("Start 7-day free trial")).toHaveCount(0)
  })

  test("trial CTA starts Stripe Checkout", async () => {
    test.skip(LIVE, "Stripe Checkout with a test card is not run against live keys")
    await navigateToBilling(page)

    await page.getByTestId("plan-card-pro").getByText("Start 7-day free trial").click()
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })
    expect(page.url()).toContain("checkout.stripe.com")
  })

  test("a trialing subscription shows the trial end date and hides the CTA", async () => {
    const started = await bootstrapTrialSubscriptionViaApi(page, TEST_USER, "pro", 7)
    test.skip(!started, "needs SHOGO_E2E_BOOTSTRAP_SECRET to bootstrap a trial")

    await navigateToBilling(page)
    await expect(page.getByText(/Free trial ends /)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("plan-card-pro").getByText("Start 7-day free trial")).toHaveCount(0)
    await expect(page.getByTestId("plan-card-basic").getByText("Start 7-day free trial")).toHaveCount(0)
  })

  test("the trial allocates the free wallet only (no monthly allowance)", async () => {
    test.skip(!process.env.SHOGO_E2E_BOOTSTRAP_SECRET, "needs SHOGO_E2E_BOOTSTRAP_SECRET")

    const state = (await signupCreditStateViaBackdoor(page, TEST_USER.email)) as SignupCreditState
    expect(state.workspaceId).toBeTruthy()

    const res = await page.request.get(
      `${bootstrapApiBase()}/api/internal/e2e/subscription-state?workspaceId=${state.workspaceId}`,
      { headers: { "x-e2e-bootstrap-secret": process.env.SHOGO_E2E_BOOTSTRAP_SECRET! } },
    )
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.subscription.status).toBe("trialing")
    // The Pro monthly allowance is $20; a trial must not carry it.
    expect(body.wallet.monthlyIncludedUsd).toBeLessThan(20)
  })

  test("the workspace-plan payload reports the trial as not eligible again", async () => {
    test.skip(!process.env.SHOGO_E2E_BOOTSTRAP_SECRET, "needs SHOGO_E2E_BOOTSTRAP_SECRET")

    const state = (await signupCreditStateViaBackdoor(page, TEST_USER.email)) as SignupCreditState
    const res = await page.request.get(`/api/billing/workspace-plan?workspaceId=${state.workspaceId}`)
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.trialEligible).toBe(false)
    expect(body.trialEndsAt).toBeTruthy()
  })
})
