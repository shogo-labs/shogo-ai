// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { Page } from "@playwright/test"

// ── Types ────────────────────────────────────────────────────────────────────

export interface TestUser {
  name: string
  email: string
  password: string
}

// ── Factories ────────────────────────────────────────────────────────────────

export function makeTestUser(prefix: string): TestUser {
  const ts = Date.now()
  return {
    name: `E2E ${prefix} ${ts}`,
    email: `e2e-${prefix.toLowerCase()}-${ts}@mailnull.com`,
    password: `E2E${prefix}Test2026!`,
  }
}

// ── Stripe constants ─────────────────────────────────────────────────────────

export const STRIPE_CARDS = {
  decline: "4000000000000002",
  success: "4242424242424242",
} as const

// ── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Signs up a new account at /sign-in, then walks through the full cloud
 * onboarding flow:
 *
 *   welcome → features → templates → get-started → home
 *
 * Leaves the browser on the home screen with "What's on your mind" visible.
 */
export async function signUpAndOnboard(page: Page, user: TestUser): Promise<void> {
  // ── Sign up ────────────────────────────────────────────────────────────────
  await page.goto("/sign-in")
  await page.getByText("Sign Up").click()
  await page.getByPlaceholder("Enter your name").fill(user.name)
  await page.getByPlaceholder("you@example.com").fill(user.email)
  await page.getByPlaceholder("Create a password").fill(user.password)
  await page
    .getByRole("button", { name: "Sign Up" })
    .or(page.getByText("Sign Up").last())
    .click()

  // ── Onboarding steps ───────────────────────────────────────────────────────
  // Each step waits for the CTA to appear before clicking so the helper is
  // safe against any future change that skips onboarding for certain accounts.

  // Step 1 – Welcome: "Get Started"
  try {
    await page.getByRole("button", { name: "Get Started" }).waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: "Get Started" }).click()
  } catch {
    // Onboarding not shown — already past welcome step
  }

  // Step 2 – Features: "Continue"
  try {
    await page.getByRole("button", { name: "Continue" }).waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: "Continue" }).click()
  } catch {
    // Already past features step
  }

  // Step 3 – Templates: "Skip & continue"
  try {
    await page.getByRole("button", { name: /Skip.*continue/i }).waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: /Skip.*continue/i }).click()
  } catch {
    // Already past templates step
  }

  // Step 4 – Get Started: "Enter Shogo"
  try {
    await page.getByRole("button", { name: "Enter Shogo" }).waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: "Enter Shogo" }).click()
  } catch {
    // Already past get-started step
  }

  // ── Home screen ────────────────────────────────────────────────────────────
  await page.waitForSelector("text=What's on your mind", { timeout: 30_000 })
}

/**
 * Signs up and onboards, selecting an app template by name during the
 * templates step. Leaves the browser on the home screen.
 */
export async function signUpAndOnboardWithAppTemplate(
  page: Page,
  user: TestUser,
  templateDisplayName: string
): Promise<void> {
  await page.goto("/sign-in")
  await page.getByText("Sign Up").click()
  await page.getByPlaceholder("Enter your name").fill(user.name)
  await page.getByPlaceholder("you@example.com").fill(user.email)
  await page.getByPlaceholder("Create a password").fill(user.password)
  await page
    .getByRole("button", { name: "Sign Up" })
    .or(page.getByText("Sign Up").last())
    .click()

  try {
    await page.getByRole("button", { name: "Get Started" }).waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: "Get Started" }).click()
  } catch {}

  try {
    await page.getByRole("button", { name: "Continue" }).waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: "Continue" }).click()
  } catch {}

  // Templates step: switch to Apps tab, select an app template
  try {
    await page.getByRole("button", { name: /Skip.*continue/i }).waitFor({ timeout: 10_000 })
    await page.getByText("Apps").click()
    await page.getByText(templateDisplayName).click()
    await page.getByRole("button", { name: /Continue with template/i }).click()
  } catch {}

  try {
    await page.getByRole("button", { name: "Enter Shogo" }).waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: "Enter Shogo" }).click()
  } catch {}

  await page.waitForSelector("text=What's on your mind", { timeout: 30_000 })
}

/**
 * Signs up, completes onboarding, then upgrades the account to Pro using
 * the Stripe test card 4242424242424242.
 *
 * Leaves the browser on the app after the Stripe redirect.
 */
// ── Interaction mode helpers ─────────────────────────────────────────────────

export async function selectInteractionMode(page: Page, mode: "Agent" | "Plan" | "Ask") {
  // Ensure no active stream (stop button gone) so the trigger is enabled
  await waitForAgentResponse(page)
  const trigger = page.locator('[data-testid="interaction-mode-trigger"]')
  await trigger.waitFor({ state: "visible", timeout: 5_000 })

  // gluestack-ui Popover trigger uses React Native Web Pressable which may not
  // respond to Playwright's synthetic click. Use dispatchEvent as fallback.
  await trigger.click()
  await page.waitForTimeout(600)

  const descriptions: Record<string, string> = {
    Agent: "Full autonomous mode",
    Plan: "Research and create a plan",
    Ask: "Just answer questions",
  }

  let popoverVisible = await page.getByText(descriptions[mode]).isVisible().catch(() => false)

  if (!popoverVisible) {
    // Fallback: dispatch pointer events directly on the DOM element
    await trigger.dispatchEvent("pointerdown")
    await page.waitForTimeout(100)
    await trigger.dispatchEvent("pointerup")
    await page.waitForTimeout(600)
    popoverVisible = await page.getByText(descriptions[mode]).isVisible().catch(() => false)
  }

  if (!popoverVisible) {
    // Last resort: evaluate JS click on the raw DOM node
    await trigger.evaluate((el: HTMLElement) => el.click())
    await page.waitForTimeout(600)
  }

  const desc = page.getByText(descriptions[mode])
  await desc.waitFor({ state: "visible", timeout: 10_000 })
  await desc.locator("..").locator("..").click()
  await page.waitForTimeout(300)
}

export async function sendChatMessage(page: Page, text: string) {
  const chatInput = page.getByPlaceholder(/Ask Shogo|Describe what|Ask a question/)
  await chatInput.click()
  await chatInput.fill(text)
  await page.waitForTimeout(300)
  await page.keyboard.press("Enter")
}

export async function waitForAgentResponse(page: Page, timeoutMs = 90_000) {
  const stopSel = '[data-testid="stop-streaming"], [aria-label="Stop"]'
  // First wait for the stop button to appear (agent starts streaming)
  try {
    await page.waitForSelector(stopSel, { state: "attached", timeout: 10_000 })
  } catch {
    // Agent may have already finished or not started — that's fine
  }
  // Then wait for it to disappear (agent done)
  await page
    .waitForSelector(stopSel, { state: "detached", timeout: timeoutMs })
    .catch(() => {})
  await page.waitForTimeout(1000)
}

export async function createProjectAndWait(page: Page, prompt: string) {
  await page.goto("/")
  await page.waitForSelector("text=What's on your mind", { timeout: 15_000 })

  const input = page.getByPlaceholder("Ask Shogo to ...")
  await input.click()
  await input.fill(prompt)
  await page.waitForTimeout(500)
  await page.keyboard.press("Enter")

  await page.waitForURL(/\/projects\//, { timeout: 60_000 })

  const stopSel = '[data-testid="stop-streaming"], [aria-label="Stop"]'
  // Wait for streaming to start
  try {
    await page.waitForSelector(stopSel, { state: "attached", timeout: 15_000 })
  } catch {
    // Agent may not have started streaming yet — that's fine
  }
  // Wait for streaming to finish
  await page
    .waitForSelector(stopSel, { state: "detached", timeout: 90_000 })
    .catch(() => {})
  await page.waitForTimeout(1000)
}

export async function signUpAndUpgradeToPro(page: Page, user: TestUser): Promise<void> {
  await signUpAndOnboard(page, user)

  await page.goto("/billing")
  // Wait for workspace + billing data to load (not just the page header).
  // The plan card section only renders after useBillingData and useActiveWorkspace resolve.
  await page.waitForSelector("text=You're on Free Plan", { timeout: 15_000 })
  // Click the plan card "Upgrade to Pro" button
  await page.getByText("Upgrade to Pro").last().click()
  // Wait for navigation to Stripe hosted checkout (window.location.href redirect)
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })

  await page.getByPlaceholder("1234 1234 1234 1234").pressSequentially(STRIPE_CARDS.success)
  await page.getByPlaceholder("MM / YY").pressSequentially("1228")
  await page.getByPlaceholder("CVC").pressSequentially("123")
  await page.getByPlaceholder("Full name on card").fill(user.name)
  await page.getByPlaceholder("ZIP").fill("10001")

  const saveCheckbox = page.getByRole("checkbox", { name: /Save my information/ })
  if (await saveCheckbox.isChecked()) await saveCheckbox.click()

  await page.getByTestId("hosted-payment-submit-button").click()
  await page.waitForURL((url) => !url.toString().includes("stripe.com"), { timeout: 30_000 })
}
