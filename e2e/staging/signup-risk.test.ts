// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { request as playwrightRequest, test, expect } from "./fixtures"
import { bootstrapApiBase, signupCreditStateViaBackdoor, verifyEmailViaBackdoor, type SignupCreditState } from "./helpers"

/**
 * Signup risk E2E.
 *
 * Covers the three outcomes the scorer can produce at the edge:
 *   1. Blocked abuse-farm domain: signup is rejected (422 SIGNUP_BLOCKED) and
 *      no account is created.
 *   2. Disposable domain without the e2e header: the account is created but
 *      gets no credit, and verifying the email does not release any.
 *   3. The admin review API is not reachable without super-admin rights.
 *
 * Signups go through the Better Auth HTTP endpoint directly (no UI). Case 2
 * and the backdoor read need SHOGO_E2E_BOOTSTRAP_SECRET; the suite skips
 * cleanly without it.
 *
 * Run: npx playwright test --config e2e/playwright.config.ts signup-risk
 */

const BASE = bootstrapApiBase()
const BACKDOOR = Boolean(process.env.SHOGO_E2E_BOOTSTRAP_SECRET)
const ts = Date.now()

async function postSignUp(email: string, extraHeaders: Record<string, string> = {}) {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Origin: BASE, ...extraHeaders },
  })
  try {
    const res = await ctx.post("/api/auth/sign-up/email", {
      data: { name: `E2E Risk ${ts}`, email, password: `E2ERisk${ts}Test2026!` },
    })
    const text = await res.text()
    let body: any = {}
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text }
    }
    return { status: res.status(), body, text }
  } finally {
    await ctx.dispose()
  }
}

test.describe("Signup risk", () => {
  test("a blocked abuse-farm domain is rejected at signup", async () => {
    const { status, text } = await postSignUp(`e2e-blocked-${ts}@hidepost.net`)
    expect(status).toBe(422)
    expect(text).toContain("SIGNUP_BLOCKED")
  })

  test("the admin signup-risk review API rejects anonymous callers", async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } })
    try {
      const res = await ctx.get("/api/admin/signup-risk")
      expect([401, 403, 404]).toContain(res.status())
    } finally {
      await ctx.dispose()
    }
  })

  test.describe("disposable domain without the e2e header", () => {
    test.skip(!BACKDOOR, "needs SHOGO_E2E_BOOTSTRAP_SECRET to read the assessment")

    const email = `e2e-nocredit-${ts}@mailnull.com`

    test("the account is created but gets no credit", async ({ page }) => {
      const { status } = await postSignUp(email)
      expect(status).toBe(200)

      const state = (await signupCreditStateViaBackdoor(page, email)) as SignupCreditState
      expect(state.assessment).not.toBeNull()
      expect(state.assessment!.decision).toBe("no_credit")
      expect(state.promoCredit?.availableUsd ?? 0).toBe(0)
      expect(state.promoCredit?.grantedUsd ?? 0).toBe(0)
    })

    test("verifying the email does not release credit for a disposable signup", async ({ page }) => {
      const outcome = await verifyEmailViaBackdoor(page, email)
      expect(outcome).not.toBeNull()
      expect(outcome!.released).toBe(false)

      const state = (await signupCreditStateViaBackdoor(page, email)) as SignupCreditState
      expect(state.promoCredit?.availableUsd ?? 0).toBe(0)
    })
  })
})
