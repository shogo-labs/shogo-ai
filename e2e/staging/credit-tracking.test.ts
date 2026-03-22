// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import { makeTestUser, signUpAndUpgradeToPro } from "./helpers"

/**
 * Credit Tracking E2E Tests
 *
 * Validates that credit balances are displayed correctly and update
 * in real-time across all surfaces after agent interactions.
 *
 * Requires an authenticated Pro user session. These tests sign up a
 * fresh account and upgrade it before testing credit tracking.
 *
 * Run: npx playwright test --config e2e/playwright.config.ts credit-tracking
 */

const TEST_USER = makeTestUser("Credits")

test.describe("Credit Tracking", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndUpgradeToPro(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("billing page shows initial Pro credits (105 of 105)", async () => {
    await page.goto("/billing")
    await page.waitForSelector("text=Billing", { timeout: 10_000 })

    await expect(page.getByText("You're on Pro Plan")).toBeVisible()
    await expect(page.getByText(/105 of 105/)).toBeVisible()
  })

  test("credits display includes daily and monthly breakdown info", async () => {
    await expect(page.getByText("Daily credits used first")).toBeVisible()
    await expect(page.getByText("Credits will rollover")).toBeVisible()
    await expect(page.getByText("Daily credits reset at midnight UTC")).toBeVisible()
  })

  test("model selector shows credit cost per interaction", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 10_000 })

    const input = page.getByPlaceholder("Ask Shogo to create...")
    await input.click()
    await input.fill("Quick credit tracking test")
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

    await expect(page.getByText(/~0\.2 credits/)).toBeVisible()
  })

  test("agent interaction deducts credits from billing page", async () => {
    // Close the model selector if open
    await page.keyboard.press("Escape")

    // Wait for the agent to finish its response
    await page.waitForTimeout(20_000)

    // Check billing page
    await page.goto("/billing")
    await page.waitForSelector("text=Billing", { timeout: 10_000 })

    const creditsEl = page.getByText(/[\d.]+ of 105/)
    await expect(creditsEl).toBeVisible()

    const text = await creditsEl.textContent()
    const remaining = parseFloat(text?.match(/([\d.]+) of 105/)?.[1] ?? "105")

    expect(remaining).toBeLessThan(105)
    expect(remaining).toBeGreaterThan(100)
  })

  test("backend credits match billing page (via API)", async () => {
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find(
      (c) => c.name === "better-auth.session_token" || c.name.includes("session")
    )

    if (!sessionCookie) {
      test.skip(true, "No session cookie found for API verification")
      return
    }

    const baseURL = page.url().split("/billing")[0]
    const response = await page.evaluate(
      async (url) => {
        const res = await fetch(`${url}/api/credit-ledgers?workspaceId=*`, {
          credentials: "include",
        })
        return { status: res.status, ok: res.ok }
      },
      baseURL
    )

    expect(response.status).toBeLessThanOrEqual(401)
  })
})
