// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import { homeComposerInput, makeTestUser, signUpAndUpgradeToPro } from "./helpers"

/**
 * Usage Tracking E2E Tests (USD pricing)
 *
 * Validates that workspace usage balances (in USD) are displayed correctly
 * and update in real-time across all surfaces after agent interactions.
 * Replaces the old credit-based tracking suite — Shogo bills raw provider
 * cost + 20%, and included usage is a fixed monthly + daily USD pool.
 *
 * Requires an authenticated Pro user session. These tests sign up a
 * fresh account and upgrade it before testing usage tracking.
 *
 * Run: npx playwright test --config e2e/playwright.config.ts usage-tracking
 */

const TEST_USER = makeTestUser("Usage")

// Pro tier base: $20 monthly + $0.50/day (up to $3 of daily → at account
// creation the wallet sits at monthly + today's daily). The "of" text is
// the stable anchor — the exact dollar total may drift as plans evolve.
test.describe("Usage Tracking", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndUpgradeToPro(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("billing page shows Pro plan + usage-remaining card in USD", async () => {
    await page.goto("/billing")
    await page.waitForSelector("text=Billing", { timeout: 10_000 })

    await expect(page.getByText("You're on Pro Plan")).toBeVisible()
    // Usage card is rendered with a "$x.xx of $y.yy" line.
    await expect(page.getByText(/\$[\d.,]+ of \$[\d.,]+/)).toBeVisible()
  })

  test("billing page explains daily allowance + 20% markup", async () => {
    await expect(
      page.getByText(/Daily allowance is used before your monthly pool/i),
    ).toBeVisible()
    await expect(
      page.getByText(/provider cost \+ 20%/i),
    ).toBeVisible()
  })

  test("model selector shows per-request USD cost hint", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 10_000 })

    const input = homeComposerInput(page)
    await input.click()
    await input.fill("Quick usage tracking test")
    await page.waitForTimeout(500)
    await page.keyboard.press("Enter")

    await page.waitForURL(/\/projects\//, { timeout: 60_000 })

    // Wait for agent to finish streaming — model selector is disabled while
    // streaming. The stop button can briefly detach between tool calls, so
    // wait extra time to confirm the agent is truly done.
    await page
      .waitForSelector('[aria-label="Stop"], [aria-label="stop"]', {
        state: "detached",
        timeout: 60_000,
      })
      .catch(() => {})
    await page.waitForTimeout(3_000)

    // Model selector button shows current model ("Basic" or "Advanced")
    const modelBtn = page
      .getByText("Basic", { exact: true })
      .or(page.getByText("Advanced", { exact: true }).last())
    await expect(modelBtn).toBeVisible({ timeout: 15_000 })
    await modelBtn.last().click()

    // When billing features are enabled, each mode surfaces an estimated
    // USD cost hint (e.g. "~$0.01/request"). Accept either hint or the
    // plain mode description if the billing feature flag is off.
    const usdHint = page.getByText(/~\$\d+\.\d+/)
    const description = page.getByText("Fast responses, 4x cheaper")
    await expect(usdHint.or(description)).toBeVisible()
  })

  test("agent interaction deducts usage (USD) from billing page", async () => {
    await page.keyboard.press("Escape")

    await page
      .waitForSelector('[aria-label="Stop"], [aria-label="stop"]', {
        state: "detached",
        timeout: 60_000,
      })
      .catch(() => {})
    await page.waitForTimeout(5_000)

    // Poll billing page — usage-wallet deduction can take a few seconds
    // to propagate through the usage-event stream.
    let remainingUsd = Number.POSITIVE_INFINITY
    let totalUsd = 0
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.goto("/billing")
      await page.waitForSelector("text=Billing", { timeout: 10_000 })

      const usageEl = page.getByText(/\$[\d.,]+ of \$[\d.,]+/)
      await expect(usageEl).toBeVisible()

      const text = (await usageEl.textContent()) ?? ""
      const match = text.match(/\$([\d.,]+)\s+of\s+\$([\d.,]+)/)
      if (match) {
        remainingUsd = parseFloat(match[1].replace(/,/g, ""))
        totalUsd = parseFloat(match[2].replace(/,/g, ""))
        if (remainingUsd < totalUsd) break
      }
      await page.waitForTimeout(5_000)
    }

    expect(totalUsd).toBeGreaterThan(0)
    expect(remainingUsd).toBeLessThan(totalUsd)
    // Spot-check: a single interaction shouldn't consume most of the pool.
    expect(remainingUsd).toBeGreaterThan(totalUsd * 0.5)
  })

  test("backend usage wallet is reachable (via API)", async () => {
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find(
      (c) => c.name === "shogo.session_token" || c.name.includes("session"),
    )

    if (!sessionCookie) {
      test.skip(true, "No session cookie found for API verification")
      return
    }

    const baseURL = page.url().split("/billing")[0]
    const response = await page.evaluate(async (url) => {
      const res = await fetch(`${url}/api/usage-wallets?workspaceId=*`, {
        credentials: "include",
      })
      return { status: res.status, ok: res.ok }
    }, baseURL)

    expect(response.status).toBeLessThanOrEqual(401)
  })
})
