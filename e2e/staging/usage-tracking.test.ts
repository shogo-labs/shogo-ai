// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import {
  createProjectAndWait,
  makeTestUser,
  signUpAndUpgradeToPro,
} from "./helpers"

/**
 * Usage Tracking E2E Tests (rolling usage windows)
 *
 * Paid plans are "unlimited within rolling windows" (5-hour + weekly), not a
 * depleting monthly USD pool (76d487a02). Validates that the billing page
 * renders both windows for a Pro workspace and that an agent turn is actually
 * charged against them.
 *
 * Window state comes from `GET /api/billing/workspace-plan`, the same call the
 * billing page makes — reading it off the page's own request keeps the test
 * independent of how the active workspace id is surfaced in the UI, and lets
 * us assert on `usedUsd` (a single short turn rounds to "0% used" on screen).
 *
 * Run: npx playwright test --config e2e/playwright.config.ts usage-tracking
 */

const TEST_USER = makeTestUser("Usage")

interface UsageWindowView {
  usedUsd: number
  limitUsd: number | null
  utilization: number
  resetsAt: string | null
}

interface WorkspacePlan {
  ok: boolean
  planId: string
  paidTier?: boolean
  usageWindows?: { fiveHour: UsageWindowView; weekly: UsageWindowView }
}

/** Opens /billing and returns the workspace-plan payload the page loaded. */
async function openBilling(page: Page): Promise<WorkspacePlan> {
  const planResponse = page.waitForResponse(
    (r) => r.url().includes("/api/billing/workspace-plan?workspaceId=") && r.ok(),
    { timeout: 30_000 },
  )
  await page.goto("/billing")
  await page.waitForSelector("text=Billing", { timeout: 10_000 })
  return (await (await planResponse).json()) as WorkspacePlan
}

test.describe("Usage Tracking", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let baselineFiveHourUsd = 0

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndUpgradeToPro(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("billing page shows Pro plan + 5-hour and weekly usage windows", async () => {
    const plan = await openBilling(page)

    await expect(page.getByText("You're on Pro Plan")).toBeVisible()
    await expect(page.getByText("Usage limits", { exact: true })).toBeVisible()
    await expect(page.getByText("5-hour window", { exact: true }).first()).toBeVisible()
    await expect(page.getByText("Weekly window", { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/\d+% used/).first()).toBeVisible()

    expect(plan.planId).toBe("pro")
    expect(plan.usageWindows).toBeTruthy()
    baselineFiveHourUsd = plan.usageWindows!.fiveHour.usedUsd
  })

  test("Pro windows are capped (not uncapped/enterprise) with positive limits", async () => {
    const plan = await openBilling(page)
    const { fiveHour, weekly } = plan.usageWindows!
    expect(fiveHour.limitUsd).toBeGreaterThan(0)
    expect(weekly.limitUsd).toBeGreaterThan(0)
    expect(weekly.limitUsd!).toBeGreaterThanOrEqual(fiveHour.limitUsd!)
  })

  test("agent interaction is charged against the rolling windows", async () => {
    await createProjectAndWait(page, "Quick usage tracking test")

    // Usage events land asynchronously after the turn finishes.
    let plan: WorkspacePlan | undefined
    for (let attempt = 0; attempt < 6; attempt++) {
      plan = await openBilling(page)
      if ((plan.usageWindows?.fiveHour.usedUsd ?? 0) > baselineFiveHourUsd) break
      await page.waitForTimeout(5_000)
    }

    const { fiveHour, weekly } = plan!.usageWindows!
    expect(fiveHour.usedUsd).toBeGreaterThan(baselineFiveHourUsd)
    // Every charge lands in both windows.
    expect(weekly.usedUsd).toBeGreaterThanOrEqual(fiveHour.usedUsd)
    expect(fiveHour.resetsAt).toBeTruthy()
    // Spot-check: one short turn must not come close to exhausting the window.
    expect(fiveHour.utilization).toBeLessThan(0.5)
  })

  test("backend usage wallet is reachable (via API)", async () => {
    const response = await page.evaluate(async () => {
      const res = await fetch(`/api/usage-wallets?workspaceId=*`, { credentials: "include" })
      return { status: res.status }
    })
    expect(response.status).toBeLessThanOrEqual(401)
  })
})
