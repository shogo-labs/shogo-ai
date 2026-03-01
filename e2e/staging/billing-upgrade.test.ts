import { test, expect, type Page } from "@playwright/test"

/**
 * Billing & Upgrade Flow E2E Tests
 *
 * Tests the complete lifecycle: sign-up → free plan → failed payment →
 * successful upgrade → Pro feature verification → credit tracking.
 *
 * Targets the deployed staging environment (studio-staging.shogo.ai).
 * Uses Stripe test cards (4000000000000002 for decline, 4242424242424242 for success).
 *
 * Run: npx playwright test --config e2e/playwright.config.ts
 */

const TEST_USER = {
  name: `E2E Billing ${Date.now()}`,
  email: `e2e-billing-${Date.now()}@mailnull.com`,
  password: "E2EBillingTest2026!",
}

const STRIPE_CARDS = {
  decline: "4000000000000002",
  success: "4242424242424242",
}

// ── Helpers ──────────────────────────────────────────────────────────

async function signUp(page: Page) {
  await page.goto("/sign-in")
  await page.getByText("Sign Up").click()
  await page.getByPlaceholder("Enter your name").fill(TEST_USER.name)
  await page.getByPlaceholder("you@example.com").fill(TEST_USER.email)
  await page.getByPlaceholder("Create a password").fill(TEST_USER.password)
  await page.getByRole("button", { name: "Sign Up" }).or(page.getByText("Sign Up").last()).click()
  await page.waitForSelector("text=What's on your mind", { timeout: 20_000 })
}

async function navigateToBilling(page: Page) {
  await page.goto("/billing")
  await page.waitForSelector("text=Plans & credits", { timeout: 10_000 })
}

async function fillStripeCheckout(
  page: Page,
  cardNumber: string,
  opts?: { name?: string; zip?: string }
) {
  const name = opts?.name ?? TEST_USER.name
  const zip = opts?.zip ?? "10001"

  await page.waitForSelector("text=Subscribe to Pro", { timeout: 15_000 })

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
    await signUp(page)

    await expect(page.getByText(/What's on your mind/)).toBeVisible()
    await expect(page.getByText(/Personal/)).toBeVisible()
  })

  // ── Phase 2: Free Plan State ─────────────────────────────────────

  test("free plan: billing page shows correct initial state", async () => {
    await navigateToBilling(page)

    await expect(page.getByText("You're on Free Plan")).toBeVisible()
    await expect(page.getByText("55 of 55")).toBeVisible()
    await expect(page.getByText("No credits will rollover")).toBeVisible()
    await expect(page.getByText("Daily credits reset at midnight UTC")).toBeVisible()
  })

  test("free plan: sidebar shows Upgrade to Pro CTA", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 10_000 })

    await expect(page.getByText("Upgrade to Pro")).toBeVisible()
    await expect(
      page.getByText("Unlock more benefits").or(page.getByText(/credits left/))
    ).toBeVisible()
  })

  test("free plan: three pricing tiers displayed", async () => {
    await navigateToBilling(page)

    await expect(page.getByText("Pro").first()).toBeVisible()
    await expect(page.getByText("$25")).toBeVisible()
    await expect(page.getByText("Business", { exact: true }).first()).toBeVisible()
    await expect(page.getByText("$560")).toBeVisible()
    await expect(page.getByText("Enterprise", { exact: true }).first()).toBeVisible()
    await expect(page.getByText("Custom", { exact: true })).toBeVisible()
  })

  // ── Phase 3: Failed Card ─────────────────────────────────────────

  test("failed card: Stripe shows decline error and stays on form", async () => {
    await navigateToBilling(page)

    // Click "Upgrade to Pro" on the Pro plan card
    const upgradeButtons = page.getByText("Upgrade to Pro")
    await upgradeButtons.last().click()

    await fillStripeCheckout(page, STRIPE_CARDS.decline)

    await page.getByTestId("hosted-payment-submit-button").click()
    await expect(
      page.getByText(/credit card was declined/)
    ).toBeVisible({ timeout: 15_000 })

    // Verify we're still on Stripe checkout (not redirected)
    expect(page.url()).toContain("checkout.stripe.com")
  })

  // ── Phase 4: Successful Upgrade ──────────────────────────────────

  test("successful card: completes upgrade and redirects to app", async () => {
    // Clear the old card number and enter the working one
    const cardInput = page.getByPlaceholder("1234 1234 1234 1234")
    await cardInput.click()
    await cardInput.press("Meta+a")
    await cardInput.press("Backspace")
    await cardInput.pressSequentially(STRIPE_CARDS.success)

    await page.getByTestId("hosted-payment-submit-button").click()

    // Wait for redirect back to app
    await page.waitForURL("**/studio-staging.shogo.ai/**", { timeout: 30_000 })
    await page.waitForLoadState("domcontentloaded")
  })

  // ── Phase 5: Post-Upgrade Billing Page ───────────────────────────

  test("post-upgrade: billing page shows Pro Plan", async () => {
    await navigateToBilling(page)

    await expect(page.getByText("You're on Pro Plan")).toBeVisible()
  })

  test("post-upgrade: credits allocated correctly (100 monthly + 5 daily)", async () => {
    await expect(page.getByText(/105 of 105/)).toBeVisible()
  })

  test("post-upgrade: credits will rollover", async () => {
    await expect(page.getByText("Credits will rollover")).toBeVisible()
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

    const input = page.getByPlaceholder("Describe the agent you want to build")
    await input.click()
    await input.fill("Test model gating for Pro plan")
    await page.waitForTimeout(500)
    await page.keyboard.press("Enter")

    await page.waitForURL(/\/projects\//, { timeout: 60_000 })

    // Wait for chat panel to load
    await expect(page.getByText("Basic")).toBeVisible({ timeout: 10_000 })

    // Open model selector
    await page.getByText("Basic").click()

    // Verify Advanced is available (not locked)
    await expect(page.getByText("Agent Mode")).toBeVisible()
    await expect(page.getByText("Advanced")).toBeVisible()
    await expect(page.getByText("Upgrade to unlock")).not.toBeVisible()
  })

  test("post-upgrade: project header hides Upgrade button for Pro users", async () => {
    // On the project page, the header should not show "Upgrade" for Pro users
    const upgradeInHeader = page.locator(
      '[class*="flex-row"][class*="items-center"] >> text=Upgrade'
    )
    await expect(upgradeInHeader).not.toBeVisible()
  })

  // ── Phase 8: Credit Tracking ─────────────────────────────────────

  test("post-upgrade: credits deducted after agent interaction", async () => {
    // Wait for the agent to finish responding to the first message
    await page.waitForTimeout(15_000)

    // Go to billing page to check credits
    await navigateToBilling(page)

    // Credits should be less than 105 (some were consumed by the agent interaction)
    const creditsText = page.getByText(/of 105/)
    await expect(creditsText).toBeVisible()

    const text = await creditsText.textContent()
    const remaining = parseFloat(text?.match(/([\d.]+) of 105/)?.[1] ?? "105")
    expect(remaining).toBeLessThan(105)
    expect(remaining).toBeGreaterThan(100)
  })

  test("post-upgrade: second interaction further deducts credits", async () => {
    // Remember current credits
    const beforeText = await page.getByText(/of 105/).textContent()
    const creditsBefore = parseFloat(beforeText?.match(/([\d.]+) of 105/)?.[1] ?? "105")

    // Go back to the project and send another message
    await page.goBack()
    await page.waitForURL(/\/projects\//, { timeout: 30_000 })

    const chatInput = page.getByPlaceholder("Ask Shogo...")
    await chatInput.fill("Add a done column to the tracker")
    await chatInput.press("Enter")

    // Wait for response
    await page.waitForTimeout(20_000)

    // Check billing page for updated credits
    await navigateToBilling(page)
    const afterText = await page.getByText(/of 105/).textContent()
    const creditsAfter = parseFloat(afterText?.match(/([\d.]+) of 105/)?.[1] ?? "105")

    expect(creditsAfter).toBeLessThan(creditsBefore)
  })

  // ── Phase 9: Manage Subscription ─────────────────────────────────

  test("post-upgrade: Manage button opens Stripe customer portal", async () => {
    await navigateToBilling(page)

    await page.getByText("Manage", { exact: true }).click()
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 15_000 })
    expect(page.url()).toContain("billing.stripe.com")
  })
})
