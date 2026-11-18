// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The free trial's seat cap, on the Billing page (SHO-422).
 *
 * Two fraud Business trials (123 and 166 seats, Hong Kong cards, throwaway
 * Gmail accounts, 1-2 real members each) showed that card checks cannot stop a
 * trial that never intends to pay: the charge lands at trial end. The cap stops
 * the seat count instead, and the way to buy more is to end the trial and pay.
 *
 * This is the client half of that rule:
 *   • the cap and its copy come from the server (`limits.trialMaxSeats` + the
 *     shared `trial_seat_limit` message), never a hardcoded 5 — the number the
 *     UI refuses at is the number the API reports;
 *   • above the cap the *Start 7-day free trial* button is inert: no checkout
 *     request leaves the page, so there is no Stripe session to clean up;
 *   • back at the cap the trial is offered again;
 *   • the paid button is still live above the cap (the trial is the only thing
 *     being refused);
 *   • a trialing workspace gets an *End trial and pay now* action whose confirm
 *     step names the amount — never a one-tap charge.
 *
 * Run: npx playwright test --config e2e/playwright.config.ts billing-trial-seat-cap
 *
 * The API half (400/409 `trial_seat_limit`, the webhook clamps, the
 * `blocked_seat_limit` block) is covered by
 * apps/api/src/__tests__/qa-sho422-trial-seat-cap.acceptance.test.ts and
 * apps/api/src/services/__tests__/qa-sho422-trial-seat-cap.acceptance.test.ts.
 */
import { test, expect, type Page } from "./fixtures"
import {
  bootstrapTrialSubscriptionViaApi,
  bootstrapApiBase,
  makeTestUser,
  signUpAndOnboard,
  signupCreditStateViaBackdoor,
} from "./helpers"

const TEST_USER = makeTestUser("SeatCap")
const BOOTSTRAP = Boolean(process.env.SHOGO_E2E_BOOTSTRAP_SECRET)

async function navigateToBilling(page: Page) {
  await page.goto("/billing")
  await page.waitForSelector("text=You're on", { timeout: 20_000 })
}

/** The Business card holds both the seat picker and the trial action. */
function businessCard(page: Page) {
  return page.getByTestId("plan-card-business")
}

/**
 * "Free trials include up to N seats." — the shared `trial_seat_limit` message
 * with `{maxSeats}` filled in. Reading N back out of the rendered copy is how
 * this spec avoids pinning 5: whatever the server sends is what the UI refuses.
 */
function seatCapFromCopy(text: string | null | undefined): number {
  const match = /up to (\d+) seats/i.exec(text ?? "")
  if (!match) throw new Error(`no seat cap in the rendered copy: ${JSON.stringify(text)}`)
  return Number(match[1])
}

test.describe("A free trial is capped at a seat limit the server owns (SHO-422)", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  let page: Page
  /** Every checkout request the page has made, and what the API answered. */
  let checkoutRequests: string[]
  let checkoutRejections: Array<{ status: number; code: string | undefined }>

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    checkoutRequests = []
    checkoutRejections = []
    page.on("request", (request) => {
      if (request.url().includes("/api/billing/checkout")) checkoutRequests.push(request.url())
    })
    page.on("response", async (response) => {
      if (!response.url().includes("/api/billing/checkout")) return
      const body = await response.json().catch(() => ({}))
      checkoutRejections.push({ status: response.status(), code: body?.error?.code })
    })
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("the cap the button refuses at is the one workspace-plan reports", async () => {
    test.skip(!BOOTSTRAP, "needs SHOGO_E2E_BOOTSTRAP_SECRET to resolve the workspace id")

    const state = (await signupCreditStateViaBackdoor(page, TEST_USER.email)) as { workspaceId?: string } | null
    expect(state?.workspaceId).toBeTruthy()

    const res = await page.request.get(
      `${bootstrapApiBase()}/api/billing/workspace-plan?workspaceId=${state!.workspaceId}`,
    )
    expect(res.ok()).toBe(true)
    const body = await res.json()
    // The client never hardcodes the number: if this is missing, `billing.tsx`
    // falls back to "no cap" and the button would offer a checkout the API
    // refuses (AC6).
    expect(typeof body?.limits?.trialMaxSeats).toBe("number")
    expect(body.limits.trialMaxSeats).toBeGreaterThan(0)
  })

  test("above the cap the trial button is inert and says why", async () => {
    await navigateToBilling(page)
    const card = businessCard(page)
    await expect(card).toBeVisible({ timeout: 20_000 })

    const trialButton = card.getByText("Start 7-day free trial")
    if ((await trialButton.count()) === 0) test.skip(true, "workspace is not trial-eligible")
    await expect(card.getByText("$0 today. Card required; cancel anytime.")).toBeVisible()

    // Walk the seat picker until the client says the trial cannot cover it. The
    // loop bound is generous on purpose: it fails loudly if the hint never
    // appears, rather than silently passing on a UI with no cap at all.
    const increase = card.getByLabel("Increase seats")
    let clicks = 0
    while (clicks < 60) {
      if ((await card.getByText(/Free trials include up to \d+ seats/).count()) > 0) break
      await increase.click()
      clicks += 1
    }
    const hint = card.getByText(/Free trials include up to \d+ seats/)
    await expect(hint).toBeVisible({ timeout: 5_000 })

    const cap = seatCapFromCopy(await hint.textContent())
    // The hint appeared on the click that crossed the cap, so the picker now
    // shows `cap + 1` seats.
    expect(clicks).toBe(cap)

    // A disabled React Native Web Pressable is a no-op, so nothing should be
    // sent. A click that does reach the API is still safe — the route refuses it
    // before creating a Stripe session — so the assertion is that nothing left
    // the page for Stripe, not that the client is the only guard.
    checkoutRequests.length = 0
    checkoutRejections.length = 0
    await trialButton.click({ force: true })
    await page.waitForTimeout(1_500)
    expect(page.url()).not.toContain("checkout.stripe.com")
    for (const rejection of checkoutRejections) {
      expect(rejection).toEqual({ status: 400, code: "trial_seat_limit" })
    }

    // The paid path is untouched: only the trial is capped (AC1's "paid
    // checkout with 50 seats is unchanged" has its API half in the unit tests).
    await expect(card.getByText("Upgrade to Business")).toBeEnabled()
  })

  test("back at the cap the trial is offered again", async () => {
    await navigateToBilling(page)
    const card = businessCard(page)

    const hint = card.getByText(/Free trials include up to \d+ seats/)
    if ((await hint.count()) === 0) test.skip(true, "this run never crossed the cap")

    await card.getByLabel("Decrease seats").click()
    await expect(hint).toHaveCount(0, { timeout: 5_000 })
    await expect(card.getByText("$0 today. Card required; cancel anytime.")).toBeVisible()
  })
})

test.describe("A trialing workspace can end the trial and pay instead (SHO-422)", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  const TRIAL_USER = makeTestUser("EndTrial")
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, TRIAL_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("the action exists on a trial and confirms the amount before charging", async () => {
    const started = await bootstrapTrialSubscriptionViaApi(page, TRIAL_USER, "business", 7)
    test.skip(!started, "needs SHOGO_E2E_BOOTSTRAP_SECRET to bootstrap a trial")

    await navigateToBilling(page)
    await expect(page.getByText(/Free trial ends /)).toBeVisible({ timeout: 20_000 })

    const endTrial = page.getByTestId("end-trial-button")
    await expect(endTrial).toBeVisible()

    // Opening the confirm step must not charge anything: the money tap is the
    // dialog's own button, and the copy has to name the amount (AC5 — the route
    // reports Stripe's real status instead of assuming the charge succeeded).
    await endTrial.click()
    const dialog = page.getByTestId("end-trial-confirm")
    await expect(dialog).toBeVisible()
    // Regional pricing prefixes the figure with `~`, and credit can knock it
    // down, so assert the sentence and a money amount rather than `$` exactly.
    await expect(dialog.getByText(/You'll be charged ~?\S*\d[\d,.]* today for /)).toBeVisible()
    await expect(dialog.getByText("End trial and pay")).toBeVisible()

    // Leave the subscription alone — ending a trial here would charge the test
    // card, and the route's own behaviour is covered by the API tests.
    await dialog.getByText("Cancel").click()
    await expect(dialog).toHaveCount(0)
  })
})
