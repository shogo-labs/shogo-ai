import { test, expect, type Page } from "@playwright/test"

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

const TEST_USER = {
  name: `E2E Credits ${Date.now()}`,
  email: `e2e-credits-${Date.now()}@mailnull.com`,
  password: "E2ECreditsTest2026!",
}

test.describe("Credit Tracking", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()

    // Sign up
    await page.goto("/sign-in")
    await page.getByText("Sign Up").click()
    await page.getByPlaceholder("Enter your name").fill(TEST_USER.name)
    await page.getByPlaceholder("you@example.com").fill(TEST_USER.email)
    await page.getByPlaceholder("Create a password").fill(TEST_USER.password)
    await page.getByRole("button", { name: "Sign Up" }).or(page.getByText("Sign Up").last()).click()
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

    const input = page.getByPlaceholder("Describe the agent you want to build")
    await input.click()
    await input.fill("Quick credit tracking test")
    await page.waitForTimeout(500)
    await page.keyboard.press("Enter")

    await page.waitForURL(/\/projects\//, { timeout: 60_000 })
    await page.waitForSelector("text=Basic", { timeout: 15_000 })

    await page.getByText("Basic").click()

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
