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
 * Signs up a new account at /sign-in, then walks through the cloud chat-style
 * onboarding flow:
 *
 *   welcome (auto-advance) → features → templates → complete → home
 *
 * Leaves the browser on the home screen with "What's on your mind" visible.
 */
export async function signUpAndOnboard(page: Page, user: TestUser): Promise<void> {
  // ── Sign up ────────────────────────────────────────────────────────────────
  await page.goto("/sign-in")
  // Switch to the Sign Up tab. The LoginScreen renders both tabs as
  // Pressables with role="tab" + accessibilityLabel "Sign Up" / "Sign In".
  await page.getByRole("tab", { name: "Sign Up" }).click()
  await page.getByPlaceholder("Enter your name").fill(user.name)
  await page.getByPlaceholder("you@example.com").fill(user.email)
  const passwordField = page.getByPlaceholder(/Create a password/)
  await passwordField.fill(user.password)
  // The shared-ui <Button> renders as a non-semantic Pressable on web, so
  // the inner "Sign Up" text is the only stable handle. Click the *last*
  // "Sign Up" element on the page (tab is first, form CTA is last).
  await page.getByText("Sign Up", { exact: true }).last().click()

  // Wait for the post-signup redirect away from /sign-in BEFORE matching
  // any onboarding text. Otherwise selectors like getByText("Continue")
  // would match the "Continue with Google" CTA that's still visible on the
  // sign-in page and trigger an OAuth redirect.
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
    timeout: 30_000,
  })

  // ── Onboarding (chat-style) ────────────────────────────────────────────────
  // The cloud flow is rendered by ChatOnboarding with widgets. The welcome
  // step auto-advances; the rest expose Pressable CTAs that are not real
  // <button>s, so we match by exact visible text. Each step is wrapped in a
  // try because future test users may bypass onboarding entirely.

  // Step 1 – Features widget: "Continue" (exact, not "Continue with Google")
  try {
    await page
      .getByText("Continue", { exact: true })
      .first()
      .waitFor({ timeout: 15_000 })
    await page.getByText("Continue", { exact: true }).first().click()
  } catch {
    // Already past features step
  }

  // Step 2 – Templates widget: "Skip" (or "Continue" if a template is preselected)
  try {
    const skip = page
      .getByText("Skip", { exact: true })
      .or(page.getByText("Continue", { exact: true }))
    await skip.first().waitFor({ timeout: 15_000 })
    await skip.first().click()
  } catch {
    // Already past templates step
  }

  // Step 3 – Complete widget: "Enter Shogo"
  try {
    await page.getByText("Enter Shogo", { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByText("Enter Shogo", { exact: true }).click()
  } catch {
    // Already past complete step
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
  await page.getByRole("tab", { name: "Sign Up" }).click()
  await page.getByPlaceholder("Enter your name").fill(user.name)
  await page.getByPlaceholder("you@example.com").fill(user.email)
  await page.getByPlaceholder("Create a password").fill(user.password)
  await page.getByText("Sign Up", { exact: true }).last().click()

  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
    timeout: 30_000,
  })

  // Step 1 – Features widget: "Continue" (exact, not "Continue with Google")
  try {
    await page
      .getByText("Continue", { exact: true })
      .first()
      .waitFor({ timeout: 15_000 })
    await page.getByText("Continue", { exact: true }).first().click()
  } catch {}

  // Step 2 – Templates widget: pick the named template, then "Continue"
  try {
    await page.getByText(templateDisplayName).waitFor({ timeout: 15_000 })
    await page.getByText(templateDisplayName).click()
    await page.getByText("Continue", { exact: true }).first().click()
  } catch {}

  // Step 3 – Complete widget: "Enter Shogo"
  try {
    await page.getByText("Enter Shogo", { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByText("Enter Shogo", { exact: true }).click()
  } catch {}

  await page.waitForSelector("text=What's on your mind", { timeout: 30_000 })
}

/**
 * Signs up, completes onboarding, then upgrades the account to Pro using
 * the Stripe test card 4242424242424242.
 *
 * Leaves the browser on the app after the Stripe redirect.
 */
// ── API Keys page helpers ────────────────────────────────────────────────────

/**
 * The `/api-keys` page was redesigned in v1.5.0: the "Devices" section is
 * primary, and manual workspace API keys live behind a collapsed
 * `"Manual API keys (N) · advanced"` accordion. Tests that need to create
 * a manual key must expand the accordion first.
 *
 * See apps/mobile/app/(app)/api-keys.tsx — the `showManualKeys` state.
 */
export async function expandManualApiKeys(page: Page) {
  const toggle = page.getByRole("button", { name: /Manual API keys/ })
  await toggle.waitFor({ state: "visible", timeout: 10_000 })
  // Avoid re-collapsing if the accordion is already open.
  const expanded = await toggle.getAttribute("aria-expanded").catch(() => null)
  if (expanded !== "true") {
    await toggle.click()
  }
  // "Create Key" only renders after the accordion animates open.
  await page
    .getByText("Create Key")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
}

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

/**
 * The home composer uses an animated typewriter placeholder
 * (`"Ask Shogo to " + rotating suggestion`), so the old
 * `getByPlaceholder("Ask Shogo to ...")` selector never matches.
 * `CompactChatInput` renders a stable `accessibilityLabel` we can target
 * regardless of interaction mode and placeholder churn.
 *
 * See apps/mobile/components/chat/CompactChatInput.tsx — the TextInput
 * label "Describe the agent you want to build".
 */
export function homeComposerInput(page: Page) {
  return page.getByRole("textbox", {
    name: "Describe the agent you want to build",
  })
}

export async function sendChatMessage(page: Page, text: string) {
  const chatInput = homeComposerInput(page)
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

  const input = homeComposerInput(page)
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
