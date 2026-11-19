// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import {
  bootstrapTrialSubscriptionViaApi,
  makeTestUser,
  signUpAndOnboard,
} from "./helpers"

/**
 * Billing page redesign (SHO-451) — the page answers three questions before
 * anything else: what plan am I on, what will I pay next, and how much usage is
 * left. This suite checks the layout that answers them, on a real deployment.
 *
 * Covers:
 *   • a Free workspace keeps the sales layout (Solo Founder + three plan cards)
 *     and gets a summary card with no price line and no payment banner;
 *   • a paying workspace gets the compact plan comparison instead of the sales
 *     cards, with its current plan marked;
 *   • "Change plan" opens a dialog that prices the change *before* anything is
 *     charged — the old path opened a second Stripe Checkout, which created a
 *     second subscription while the first kept billing;
 *   • the cancel dialog says what happens to access, data and limits, and is
 *     reachable only on a paid workspace.
 *
 * Nothing here confirms a change: the dialogs are opened, read and dismissed,
 * so the suite never mutates a subscription or charges a card.
 *
 * Run: npx playwright test --config e2e/playwright.config.ts billing-page-redesign
 */

const FREE_USER = makeTestUser("BillingFree")
const PAID_USER = makeTestUser("BillingPaid")

async function navigateToBilling(page: Page) {
  await page.goto("/billing")
  // The summary card is the first thing the page renders once the workspace and
  // the summary call have resolved.
  await page.waitForSelector("text=You're on", { timeout: 20_000 })
}

test.describe("Billing page redesign — Free workspace", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, FREE_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("the summary card answers the plan first", async () => {
    await navigateToBilling(page)

    const summary = page.getByTestId("billing-summary")
    await expect(summary).toBeVisible()
    await expect(summary.getByText("You're on Free Plan")).toBeVisible()
    // A Free workspace has no recurring price and no renewal to show.
    await expect(page.getByTestId("billing-summary-price")).toHaveCount(0)
    await expect(page.getByTestId("billing-summary-renewal")).toContainText(
      "No renewal scheduled",
    )
    await expect(page.getByTestId("billing-summary-seats")).toContainText("1")
  })

  test("no payment problem means no banner", async () => {
    await navigateToBilling(page)
    await expect(page.getByTestId("billing-payment-banner")).toHaveCount(0)
  })

  test("a Free workspace keeps the sales layout", async () => {
    await navigateToBilling(page)

    // The three plan cards are how a Free workspace is sold the product.
    await expect(page.getByTestId("plan-card-basic")).toBeVisible()
    await expect(page.getByTestId("plan-card-business")).toBeVisible()
    await expect(page.getByTestId("plan-card-enterprise")).toBeVisible()
    // Pro is retired (SHO-397) and the compact comparison is for payers only.
    await expect(page.getByTestId("plan-card-pro")).toHaveCount(0)
    await expect(page.getByTestId("plan-comparison")).toHaveCount(0)
  })

  test("a Free workspace is not offered Change plan or Cancel", async () => {
    await navigateToBilling(page)

    // There is no subscription to change or cancel — Checkout is the only path.
    await expect(page.getByTestId("billing-change-plan")).toHaveCount(0)
    await expect(page.getByTestId("billing-cancel-link")).toHaveCount(0)
  })
})

test.describe("Billing page redesign — paying workspace", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let bootstrapped = false

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, PAID_USER)
    bootstrapped = await bootstrapTrialSubscriptionViaApi(page, PAID_USER, "business", 7)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("the summary card names the plan and its trial end", async () => {
    test.skip(!bootstrapped, "needs SHOGO_E2E_BOOTSTRAP_SECRET to bootstrap a subscription")
    await navigateToBilling(page)

    const summary = page.getByTestId("billing-summary")
    await expect(summary).toBeVisible()
    await expect(summary.getByText("You're on Business Plan")).toBeVisible()
    await expect(summary.getByText("Free trial")).toBeVisible()
    await expect(page.getByTestId("billing-summary-renewal")).toContainText("Trial ends")
    // Business is per-seat, so the price line is present and per month.
    await expect(page.getByTestId("billing-summary-price")).toContainText("per month")
  })

  test("a paying workspace gets the comparison, not the sales cards", async () => {
    test.skip(!bootstrapped, "needs SHOGO_E2E_BOOTSTRAP_SECRET to bootstrap a subscription")
    await navigateToBilling(page)

    const comparison = page.getByTestId("plan-comparison")
    await expect(comparison).toBeVisible()
    // The current plan is marked, and the other tier is one row away.
    await expect(page.getByTestId("plan-row-business")).toContainText("Current plan")
    await expect(page.getByTestId("plan-row-basic")).toContainText("Switch to Basic")
    // The three big sales cards are gone — that is the point of the redesign.
    await expect(page.getByTestId("plan-card-basic")).toHaveCount(0)
    await expect(page.getByTestId("plan-card-business")).toHaveCount(0)
  })

  test("Change plan prices the change before anything is charged", async () => {
    test.skip(!bootstrapped, "needs SHOGO_E2E_BOOTSTRAP_SECRET to bootstrap a subscription")
    await navigateToBilling(page)

    await page.getByTestId("billing-change-plan").click()

    const dialog = page.getByTestId("plan-change-dialog")
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    // The preview lands: today's price, the new price, and what is charged now.
    await expect(dialog.getByText("Today")).toBeVisible()
    await expect(dialog.getByText("After the change")).toBeVisible()
    await expect(dialog.getByText("Charged today")).toBeVisible()
    await expect(page.getByTestId("plan-change-proration")).toBeVisible()
    // The confirm is only enabled once a price has been shown.
    await expect(page.getByTestId("plan-change-confirm")).toBeEnabled()

    // Dismiss without confirming: this suite never mutates a subscription.
    await dialog.getByLabel("Close").click()
    await expect(dialog).toHaveCount(0)
  })

  test("the cancel dialog says what happens before it cancels", async () => {
    test.skip(!bootstrapped, "needs SHOGO_E2E_BOOTSTRAP_SECRET to bootstrap a subscription")
    await navigateToBilling(page)

    await page.getByTestId("billing-cancel-link").click()

    const dialog = page.getByTestId("cancel-subscription-dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/You keep access to your Business plan/)).toBeVisible()
    await expect(dialog.getByText(/drops to Free limits/)).toBeVisible()
    // A Business workspace is offered the cheaper downgrade first.
    await expect(page.getByTestId("cancel-switch-to-basic")).toBeVisible()

    // Dismiss without cancelling.
    await dialog.getByLabel("Close").click()
    await expect(dialog).toHaveCount(0)
  })
})
