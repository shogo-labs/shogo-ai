// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import { isLiveStripeEnv, makeTestUser, signUpAndOnboard } from "./helpers"

/**
 * SHO-397 — Pro ($20/seat) is retired and must not be purchasable anywhere.
 *
 * v2.5.0 (SHO-339) replaced Pro with Basic $8 and Business $16/seat, but the
 * Pro card stayed on sale on Billing and New workspace, both checkout routes
 * still accepted `planId: 'pro'`, and `PUT /ai/v1/subscription` granted any
 * plan for free. This spec is the QA gate for the fix:
 *
 *   • Billing (desktop and phone viewport) offers Basic / Business / Enterprise
 *     and has no Pro card, no Pro trial CTA and no "Upgrade to Pro" button;
 *   • New workspace offers Business only and posts `planId: 'business'`;
 *   • posting `planId: 'pro'` straight at either checkout route still lands on
 *     the Business $16 price, never the retired $20 Pro price;
 *   • `PUT /api/ai/v1/subscription` is 404 on production and still reachable
 *     (401 without a token) on staging/local.
 *
 * The Stripe assertions need test-mode keys, so they skip on a live target.
 *
 * Run: npx playwright test --config e2e/playwright.config.ts billing-pro-retired
 */

const TEST_USER = makeTestUser("ProRetired")
const LIVE = isLiveStripeEnv()

async function navigateToBilling(page: Page) {
  await page.goto("/billing")
  await page.waitForSelector("text=You're on", { timeout: 15_000 })
}

/** The signed-in user's non-personal workspace (the one sign-up seeds). */
async function activeWorkspaceId(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const res = await fetch("/api/workspaces", { credentials: "include" })
    if (!res.ok) throw new Error(`list workspaces failed: ${res.status}`)
    const json = await res.json()
    const items = (json?.items ?? json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
    return items.find((w) => w.kind !== "personal")?.id ?? items[0]?.id ?? null
  })
  if (!id) throw new Error("no workspace for the signed-in user")
  return id
}

/** Opens a Stripe Checkout session URL in its own tab and returns its text. */
async function stripeCheckoutText(page: Page, url: string): Promise<string> {
  const checkout = await page.context().newPage()
  try {
    await checkout.goto(url, { waitUntil: "domcontentloaded" })
    await checkout.waitForSelector("body", { timeout: 30_000 })
    // Stripe renders the line item asynchronously; give it a moment to settle.
    await checkout.waitForTimeout(2_000)
    return (await checkout.locator("body").innerText()) ?? ""
  } finally {
    await checkout.close()
  }
}

test.describe("Pro is retired — no path sells it (SHO-397)", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("Billing offers Basic / Business / Enterprise and no Pro card", async () => {
    await navigateToBilling(page)

    await expect(page.getByTestId("plan-card-basic")).toBeVisible()
    await expect(page.getByTestId("plan-card-business")).toBeVisible()
    await expect(page.getByTestId("plan-card-enterprise")).toBeVisible()

    // The retired plan has no card, no trial CTA and no upgrade button.
    await expect(page.getByTestId("plan-card-pro")).toHaveCount(0)
    await expect(page.getByText("Upgrade to Pro")).toHaveCount(0)
    // Every upsell CTA names the plan that is on sale (SHO-398).
    await expect(page.getByTestId("sidebar-upgrade-cta").getByText("Upgrade to Business")).toBeVisible()
    for (const plan of ["basic", "business"] as const) {
      await expect(
        page.getByTestId(`plan-card-${plan}`).getByText("Start 7-day free trial"),
      ).toBeVisible()
    }
    await expect(page.getByTestId("plan-card-business").getByText("Upgrade to Business")).toBeVisible()
    // No copy on the page still presents Pro as the tier below Business.
    await expect(page.getByText("Everything in Pro")).toHaveCount(0)
  })

  test("Billing at a phone viewport also has no Pro card", async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    try {
      await navigateToBilling(page)

      await expect(page.getByTestId("plan-card-basic")).toBeVisible()
      await expect(page.getByTestId("plan-card-business")).toBeVisible()
      await expect(page.getByTestId("plan-card-pro")).toHaveCount(0)
      await expect(page.getByText("Upgrade to Pro")).toHaveCount(0)
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 })
    }
  })

  test("New workspace offers Business only and posts planId business", async () => {
    test.skip(LIVE, "creates a Stripe Checkout session — test-mode keys only")

    await page.goto("/new-workspace")
    await expect(page.getByText("2. Choose a plan")).toBeVisible({ timeout: 15_000 })

    // Business is the only per-seat plan on the page; Enterprise is sales-led.
    await expect(page.getByText("Business", { exact: true })).toBeVisible()
    await expect(page.getByText("Enterprise", { exact: true })).toBeVisible()
    await expect(page.getByText("Pro", { exact: true })).toHaveCount(0)

    await page.getByLabel("Workspace name").fill(`Pro Retired ${Date.now()}`)

    const checkoutRequest = page.waitForRequest(
      (req) => req.url().includes("/api/billing/workspace-checkout") && req.method() === "POST",
      { timeout: 30_000 },
    )
    await page.getByText("Subscribe & Create").click()

    const body = JSON.parse((await checkoutRequest).postData() ?? "{}")
    expect(body.planId).toBe("business")

    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })
    await expect(page.getByText(/Subscribe to (Shogo )?Business/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("$16.00")).toBeVisible()
  })

  test("a direct pro checkout on /api/billing/checkout lands on Business $16", async () => {
    test.skip(LIVE, "creates a Stripe Checkout session — test-mode keys only")

    const workspaceId = await activeWorkspaceId(page)
    const res = await page.request.post("/api/billing/checkout", {
      data: { workspaceId, planId: "pro", billingInterval: "monthly", seats: 1 },
    })
    expect(res.status()).toBe(200)
    const session = (await res.json()) as { url?: string }
    expect(session.url, "checkout returned no Stripe URL").toBeTruthy()

    const text = await stripeCheckoutText(page, session.url!)
    expect(text).toMatch(/Subscribe to (Shogo )?Business/)
    expect(text).toContain("$16.00")
    expect(text).not.toContain("$20.00")
  })

  test("a direct pro checkout on /api/billing/workspace-checkout lands on Business $16", async () => {
    test.skip(LIVE, "creates a Stripe Checkout session — test-mode keys only")

    const res = await page.request.post("/api/billing/workspace-checkout", {
      data: {
        workspaceName: `Pro Retired API ${Date.now()}`,
        planId: "pro",
        billingInterval: "monthly",
        seats: 1,
      },
    })
    expect(res.status()).toBe(200)
    const session = (await res.json()) as { url?: string }
    expect(session.url, "workspace checkout returned no Stripe URL").toBeTruthy()

    const text = await stripeCheckoutText(page, session.url!)
    expect(text).toMatch(/Subscribe to (Shogo )?Business/)
    expect(text).toContain("$16.00")
    expect(text).not.toContain("$20.00")
  })

  test("PUT /api/ai/v1/subscription is gated by environment", async () => {
    const res = await page.request.put("/api/ai/v1/subscription", {
      data: { planId: "business" },
    })

    if (LIVE) {
      // Production: the debug route does not exist at all.
      expect(res.status()).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe("not_found")
    } else {
      // Staging and local keep the route for tests, so an unauthenticated call
      // reaches the auth check and is rejected there — not by the env gate.
      expect(res.status()).toBe(401)
    }
  })
})
