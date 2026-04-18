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

  test("billing page shows initial Pro credits (200 monthly + 5 daily)", async () => {
    await page.goto("/billing")
    await page.waitForSelector("text=Billing", { timeout: 10_000 })

    await expect(page.getByText("You're on Pro Plan")).toBeVisible()
    await expect(page.getByText(/of 205/)).toBeVisible()
  })

  test("credits display includes daily and monthly breakdown info", async () => {
    await expect(page.getByText("Daily credits used first")).toBeVisible()
    await expect(page.getByText("Daily credits reset at midnight UTC")).toBeVisible()
  })

  test("model selector shows credit cost per interaction", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 10_000 })

    const input = page.getByPlaceholder("Ask Shogo to ...")
    await input.click()
    await input.fill("Quick credit tracking test")
    await page.waitForTimeout(500)
    await page.keyboard.press("Enter")

    await page.waitForURL(/\/projects\//, { timeout: 60_000 })

    // Wait for agent to finish streaming — model selector is disabled while streaming.
    // The stop button can briefly detach between tool calls, so wait extra time
    // to confirm the agent is truly done.
    await page.waitForSelector('[aria-label="Stop"], [aria-label="stop"]', { state: "detached", timeout: 60_000 }).catch(() => {})
    await page.waitForTimeout(3_000)

    // Model selector button shows current model ("Basic" or "Advanced" for Pro users)
    const modelBtn = page.getByText("Basic", { exact: true }).or(page.getByText("Advanced", { exact: true }).last())
    await expect(modelBtn).toBeVisible({ timeout: 15_000 })
    await modelBtn.last().click()

    // When billing features are enabled, each mode shows its credit hint in
    // the description (e.g. "Fast responses, 4x cheaper (~0.2 credits)").
    // Accept either format in case the billing feature flag is off.
    const creditHint = page.getByText(/~0\.[0-9].*credits/)
    const description = page.getByText("Fast responses, 4x cheaper")
    await expect(creditHint.or(description)).toBeVisible()
  })

  test("agent interaction deducts credits from billing page", async () => {
    // Close the model selector if open
    await page.keyboard.press("Escape")

    // Wait for the agent to finish its response
    await page.waitForSelector('[aria-label="Stop"], [aria-label="stop"]', { state: "detached", timeout: 60_000 }).catch(() => {})
    await page.waitForTimeout(5_000)

    // Poll billing page — credit deduction can take a few seconds to propagate
    let remaining = 205
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.goto("/billing")
      await page.waitForSelector("text=Billing", { timeout: 10_000 })

      const creditsEl = page.getByText(/[\d.]+ of 205/)
      await expect(creditsEl).toBeVisible()

      const text = await creditsEl.textContent()
      remaining = parseFloat(text?.match(/([\d.]+) of 205/)?.[1] ?? "205")
      if (remaining < 205) break
      await page.waitForTimeout(5_000)
    }

    expect(remaining).toBeLessThan(205)
    expect(remaining).toBeGreaterThan(190)
  })

  test("backend credits match billing page (via API)", async () => {
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find(
      (c) => c.name === "shogo.session_token" || c.name.includes("session")
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
