// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page } from "./fixtures"
import {
  buildPromptInput,
  extendTestTimeout,
  isLiveStripeEnv,
  makeTestUser,
  signUpAndOnboard,
  verifyEmailViaBackdoor,
  type TestUser,
} from "./helpers"

/**
 * QA acceptance for SHO-614: the marketing site's `?prompt=` / `?plan=` reach
 * the first build.
 *
 * The unit and RTL suites cover the parsing, the countdown and the captures.
 * What only a real browser plus a real account can prove is the hop across
 * sign-up: the cookie that rides the sign-up POST, the row it is stored on, and
 * the second device that never saw the marketing link. That is this file.
 *
 *   E2E_TARGET_URL=https://studio.staging.shogo.ai \
 *     npx playwright test --config e2e/playwright.config.ts qa-sho614-signup-intent
 *
 * Backdoor-gated: the verify-email step and the checkout body assertions need
 * `SHOGO_E2E_BOOTSTRAP_SECRET` / a test-mode Stripe key, and say so when absent.
 */

const BACKDOOR = Boolean(process.env.SHOGO_E2E_BOOTSTRAP_SECRET)
const LIVE_STRIPE = isLiveStripeEnv()

const PROMPT = "A booking page for my salon"
const WORKSPACE_CHAT_POST = /\/api\/workspaces\/([^/]+)\/chat(\?|$)/
const BUILD_INSTRUCTIONS = "Build a first working version of this in that turn"
const INTENT_ENDPOINT = "/api/onboarding/intent"

/** Fills and submits the sign-up form on whatever page is showing. */
async function submitSignUp(page: Page, user: TestUser): Promise<void> {
  await page.getByRole("tab", { name: "Sign Up" }).click()
  await page.getByPlaceholder("Enter your name").fill(user.name)
  await page.getByPlaceholder("you@example.com").fill(user.email)
  await page.getByPlaceholder(/Create a password/).fill(user.password)
  // The shared-ui <Button> is a Pressable on web; the form CTA is the last
  // "Sign Up" on the page once the tab is selected.
  await page.getByText("Sign Up", { exact: true }).last().click()
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 })
}

/**
 * Opens the marketing link, then signs up with the email form. `/sign-up`
 * redirects to `/sign-in` and keeps the query string, so the sign-up POST still
 * carries the `__shogo_intent` cookie the root layout wrote.
 */
async function signUpFromLink(page: Page, user: TestUser, query: string): Promise<void> {
  await page.goto(`/sign-up?${query}`)
  await submitSignUp(page, user)
}

/** Signs an existing account in on a browser that never opened the link. */
async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto("/sign-in")
  await page.getByPlaceholder("you@example.com").fill(user.email)
  // The sign-in tab's own placeholder — not the sign-up form's "Create a
  // password", which is a different field on the same screen.
  await page.getByPlaceholder("Enter your password").fill(user.password)
  await page.getByText("Sign In", { exact: true }).last().click()
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 })
}

/** Watches the workspace chat endpoint and resolves with the POST it sent. */
function watchWorkspaceChatPost(page: Page) {
  return page.waitForRequest(
    (req) => req.method() === "POST" && WORKSPACE_CHAT_POST.test(req.url()),
    { timeout: 120_000 },
  )
}

/** True when the build step is on screen with a prefilled value. */
async function waitForPrefilledBuildStep(page: Page, prompt: string) {
  const input = buildPromptInput(page)
  await expect(input).toBeVisible({ timeout: 120_000 })
  await expect(input).toHaveValue(prompt, { timeout: 30_000 })
  return input
}

test.describe("SHO-614 sign-up intent", () => {
  test.describe.configure({ mode: "serial" })

  // AC1 — the hero link survives email sign-up and the first build starts by
  // itself, with the visitor never retyping their idea.
  test("`?prompt=` from the hero link prefills the build step and builds itself", async ({ page }) => {
    test.skip(!BACKDOOR, "needs SHOGO_E2E_BOOTSTRAP_SECRET to verify the email")
    const user = makeTestUser("IntentHero")

    await signUpFromLink(page, user, `mode=signup&prompt=${encodeURIComponent(PROMPT)}&intent=hero_prompt`)

    // The capture ran during the root layout's first render and both copies
    // exist before the account does.
    expect(await page.evaluate(() => window.localStorage.getItem("shogo_signup_intent"))).toContain(PROMPT)

    const verified = await verifyEmailViaBackdoor(page, user.email)
    expect(verified, "verify-email backdoor unavailable").not.toBeNull()

    // Team setup is skipped: the workspace already exists and the visitor came
    // to see their idea built.
    await waitForPrefilledBuildStep(page, PROMPT)
    await expect(page.getByText("Set up your team workspace")).toHaveCount(0)

    // A visible countdown, with the escape the AC names.
    const countdown = page.getByTestId("onboarding-auto-run")
    await expect(countdown).toBeVisible({ timeout: 30_000 })
    expect(await countdown.textContent()).toContain("Building this in")
    await expect(page.getByTestId("onboarding-edit-first")).toBeVisible()

    // It runs on its own: no click, and the brief carries the idea.
    const chatPost = await watchWorkspaceChatPost(page)
    extendTestTimeout(60_000)
    await page.waitForURL(/\/agent\?.*chatSessionId=/, { timeout: 60_000 })

    const body = chatPost.postData() ?? ""
    expect(body).toContain(PROMPT)
    expect(body).toContain(BUILD_INSTRUCTIONS)
    expect(body).toContain("::Build Brief::")
    // The intent is consumed once the build has started.
    expect(await page.evaluate(() => window.localStorage.getItem("shogo_signup_intent"))).toBeNull()
  })

  // AC2 — verifying on another device: the prompt comes from the account, not
  // from a localStorage entry that browser never had.
  test("a fresh browser with no localStorage reads the prompt from the account", async ({ browser }) => {
    test.skip(!BACKDOOR, "needs SHOGO_E2E_BOOTSTRAP_SECRET to verify the email")
    const user = makeTestUser("IntentDeviceA")
    const crossDevicePrompt = `A job tracker for my crew ${Date.now()}`

    // Device A: the marketing link, the sign-up, the verification — and no
    // onboarding, so the intent stays on the account.
    const contextA = await browser.newContext()
    const pageA = await contextA.newPage()
    try {
      await signUpFromLink(pageA, user, `prompt=${encodeURIComponent(crossDevicePrompt)}&intent=hero_prompt`)
      const verified = await verifyEmailViaBackdoor(pageA, user.email)
      expect(verified, "verify-email backdoor unavailable").not.toBeNull()
    } finally {
      await contextA.close()
    }

    // Device B: signed in, and it has never seen the link.
    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    try {
      expect(await pageB.evaluate(() => window.localStorage.getItem("shogo_signup_intent"))).toBeNull()
      await signIn(pageB, user)
      expect(await pageB.evaluate(() => window.localStorage.getItem("shogo_signup_intent"))).toBeNull()

      const intentResponse = pageB.waitForResponse(
        (res) => res.url().includes(INTENT_ENDPOINT) && res.request().method() === "GET",
        { timeout: 60_000 },
      )
      await waitForPrefilledBuildStep(pageB, crossDevicePrompt)
      const payload = await (await intentResponse).json()
      expect(payload?.data?.intent?.prompt).toBe(crossDevicePrompt)
    } finally {
      await contextB.close()
    }
  })

  // AC5 — a crafted link cannot send anything in someone's existing workspace.
  test("an already-onboarded account opening `/?prompt=` sends nothing", async ({ page }) => {
    const user = makeTestUser("IntentExisting")
    await signUpAndOnboard(page, user)

    const sent: string[] = []
    page.on("request", (req) => {
      if (req.method() === "POST" && WORKSPACE_CHAT_POST.test(req.url())) {
        sent.push(req.postData() ?? "")
      }
    })

    await page.goto(`/?prompt=${encodeURIComponent("Send this into my workspace without asking")}`)

    // Give a countdown time to appear and a build time to start. Neither may.
    await page.waitForTimeout(10_000)
    await expect(page.getByTestId("onboarding-auto-run")).toHaveCount(0)
    expect(sent, `unexpected chat posts: ${sent.join(" | ")}`).toEqual([])
    await expect(page.getByText("Send this into my workspace without asking")).toHaveCount(0)
  })

  // AC6 — a pricing link with no idea still starts the plan the visitor tapped.
  test("`?plan=basic&trial=1` starts the Basic trial checkout", async ({ page }) => {
    test.skip(LIVE_STRIPE, "Stripe Checkout is not driven against live keys")
    const user = makeTestUser("IntentPlanBasic")

    const checkoutPost = page.waitForRequest(
      (req) => req.method() === "POST" && req.url().includes("/api/billing/checkout"),
      { timeout: 120_000 },
    )

    await signUpFromLink(page, user, "plan=basic&trial=1")
    // No prompt: the build step is empty, so the visitor skips it and the plan
    // they tapped is what happens next.
    await expect(buildPromptInput(page)).toBeVisible({ timeout: 120_000 })
    await page.getByText("I'll explore first", { exact: true }).click()

    await page.waitForURL(/\/billing(\?|$)/, { timeout: 60_000 })
    const request = await checkoutPost
    const body = JSON.parse(request.postData() ?? "{}")
    expect(body.planId).toBe("basic")
    expect(body.trial).toBe(true)
    expect(body.seats).toBe(1)
  })

  test("`?plan=business` without a trial starts the normal Business checkout", async ({ page }) => {
    test.skip(LIVE_STRIPE, "Stripe Checkout is not driven against live keys")
    const user = makeTestUser("IntentPlanBusiness")

    const checkoutPost = page.waitForRequest(
      (req) => req.method() === "POST" && req.url().includes("/api/billing/checkout"),
      { timeout: 120_000 },
    )

    await signUpFromLink(page, user, "plan=business")
    await expect(buildPromptInput(page)).toBeVisible({ timeout: 120_000 })
    await page.getByText("I'll explore first", { exact: true }).click()

    await page.waitForURL(/\/billing(\?|$)/, { timeout: 60_000 })
    const body = JSON.parse((await checkoutPost).postData() ?? "{}")
    expect(body.planId).toBe("business")
    expect(body.trial).toBeUndefined()
  })
})
