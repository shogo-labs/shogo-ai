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
 * Signs up, completes onboarding, then upgrades the account to Pro using
 * the Stripe test card 4242424242424242.
 *
 * Leaves the browser on the app after the Stripe redirect.
 */
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
  await page.waitForURL("**/studio-staging.shogo.ai/**", { timeout: 30_000 })
}
