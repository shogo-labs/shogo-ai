// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"

/**
 * User Analytics E2E Tests
 *
 * Tests the analytics tab in workspace settings and the usage section
 * on the profile page. Signs up a fresh account, then verifies the
 * analytics UI and API endpoints work correctly.
 *
 * Prerequisites:
 *   bun run api:dev    (API server on port 8002)
 *   bun run web:dev    (Expo web on port 8081)
 *
 * NOTE: this spec drives workspace settings through the Command Palette so it
 * exercises the in-app path a user takes. (Until SHO-110 a plain `/settings` URL
 * was ambiguous — (admin)/settings.tsx and (app)/settings.tsx both answered it
 * and the admin console won; the admin AI screen now lives at /admin/settings.)
 *
 * Run:
 *   npx playwright test --config e2e/dev/playwright.config.ts user-analytics
 *   npx playwright test --config e2e/dev/playwright.config.ts user-analytics --headed
 */

interface TestUser {
  name: string
  email: string
  password: string
}

function makeTestUser(): TestUser {
  const ts = Date.now()
  return {
    name: `E2E Analytics ${ts}`,
    email: `e2e-analytics-${ts}@mailnull.com`,
    password: `E2EAnalyticsTest2026!`,
  }
}

async function signUpAndOnboard(page: Page, user: TestUser): Promise<void> {
  await page.goto("/sign-in")
  await page.waitForLoadState("networkidle")

  await page.getByText("Sign Up").click()
  await page.getByPlaceholder("Enter your name").fill(user.name)
  await page.getByPlaceholder("you@example.com").fill(user.email)
  await page.getByPlaceholder("Create a password").fill(user.password)
  await page
    .getByRole("button", { name: "Sign Up" })
    .or(page.getByText("Sign Up").last())
    .click()

  try {
    await page
      .getByRole("button", { name: "Get Started" })
      .waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: "Get Started" }).click()
  } catch {}

  try {
    await page
      .getByRole("button", { name: "Continue" })
      .waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: "Continue" }).click()
  } catch {}

  try {
    await page
      .getByRole("button", { name: /Skip.*continue/i })
      .waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: /Skip.*continue/i }).click()
  } catch {}

  try {
    await page
      .getByRole("button", { name: "Enter Shogo" })
      .waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: "Enter Shogo" }).click()
  } catch {}

  // Onboarding finishes on `/`, which is the empty agent chat now; the builder
  // moved to `/home`.
  await page.goto("/home")
  await page.waitForSelector("text=What are we building", { timeout: 30_000 })
}

async function navigateToSettingsAnalytics(page: Page) {
  await page.keyboard.press("Meta+k")
  await page.waitForSelector("text=Workspace Analytics", { timeout: 5_000 })
  await page.getByText("Workspace Analytics").click()
  await page.waitForSelector("text=Team Analytics", { timeout: 15_000 })
}

test.describe("User Analytics", () => {
  test.describe.configure({ mode: "serial" })

  const TEST_USER = makeTestUser()
  let page: Page
  let workspaceId = ""
  const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:8002"

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    // Remember the active workspace so the dashboard contract can be checked
    // against the per-endpoint routes on the same rows.
    page.on("request", (request) => {
      const match = request.url().match(/\/api\/workspaces\/([^/]+)\//)
      if (match && !workspaceId) workspaceId = match[1]
    })
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  // ── Settings: Analytics Tab ─────────────────────────────────────────────

  test("workspace analytics tab is accessible via command palette", async () => {
    await navigateToSettingsAnalytics(page)

    await expect(page.getByText("Analytics", { exact: true })).toBeVisible({
      timeout: 5_000,
    })
  })

  test("workspace analytics shows upgrade prompt for free plan", async () => {
    await expect(page.getByText("Team Analytics")).toBeVisible({
      timeout: 10_000,
    })
    await expect(
      page.getByText(/available on Business plans/i)
    ).toBeVisible()
    await expect(page.getByText("Upgrade to Business")).toBeVisible()
  })

  // ── Profile: Usage & Spend ──────────────────────────────────────────────

  test("profile page shows Usage & Spend section", async () => {
    await page.goto("/profile")
    await page.waitForLoadState("networkidle")

    await expect(page.getByText("Profile")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Account Information")).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText("Usage & Spend")).toBeVisible({
      timeout: 10_000,
    })
  })

  test("profile usage shows period selector", async () => {
    await expect(page.getByText("7 days")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText("30 days")).toBeVisible()
  })

  test("profile usage shows overview stats after data loads", async () => {
    await page.waitForTimeout(5_000)

    await expect(page.getByText("Sessions")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("Usage Events")).toBeVisible()
    await expect(page.getByText("Spend")).toBeVisible()
  })

  test("profile usage shows AI usage table", async () => {
    await expect(page.getByText("Your AI Usage")).toBeVisible({
      timeout: 10_000,
    })
  })

  // ── API: /me/analytics endpoints ────────────────────────────────────────

  test("API /me/analytics/overview returns data", async () => {
    const response = await page.evaluate(
      async (apiUrl) => {
        const r = await fetch(`${apiUrl}/api/me/analytics/overview?period=30d`, {
          credentials: "include",
        })
        const json = await r.json()
        return { status: r.status, ok: json.ok, data: json.data }
      },
      process.env.EXPO_PUBLIC_API_URL || "http://localhost:8002"
    )

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.data).toHaveProperty("usageEvents")
    expect(response.data).toHaveProperty("totalSpendUsd")
    expect(response.data).toHaveProperty("chatSessions")
  })

  test("API /me/analytics/usage-log returns paginated data", async () => {
    const response = await page.evaluate(
      async (apiUrl) => {
        const r = await fetch(
          `${apiUrl}/api/me/analytics/usage-log?period=30d&page=1&limit=10`,
          { credentials: "include" }
        )
        const json = await r.json()
        return { status: r.status, ok: json.ok, data: json.data }
      },
      process.env.EXPO_PUBLIC_API_URL || "http://localhost:8002"
    )

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.data).toHaveProperty("entries")
    expect(response.data).toHaveProperty("total")
    expect(response.data).toHaveProperty("page")
    expect(response.data).toHaveProperty("limit")
  })

  test("API /me/analytics/usage-summary returns data", async () => {
    const response = await page.evaluate(
      async (apiUrl) => {
        const r = await fetch(
          `${apiUrl}/api/me/analytics/usage-summary?period=30d`,
          { credentials: "include" }
        )
        const json = await r.json()
        return { status: r.status, ok: json.ok, data: json.data }
      },
      process.env.EXPO_PUBLIC_API_URL || "http://localhost:8002"
    )

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.data).toHaveProperty("summaries")
    expect(response.data).toHaveProperty("totals")
  })

  // ── API: /workspaces/:id/analytics/dashboard (SHO-140) ─────────────────

  // The Usage tab's request count is pinned in
  // `apps/mobile/components/analytics/__tests__/WorkspaceUsagePanel.dashboard.rtl.test.tsx`
  // (this suite signs up a free-plan workspace, where the panel is behind the
  // Business gate). What is checked here is that the one endpoint the tab now
  // calls answers, is authorised, and agrees with the endpoints it replaced.
  test("API analytics dashboard agrees with the per-endpoint routes", async () => {
    expect(workspaceId).not.toBe("")

    const result = await page.evaluate(
      async ({ apiUrl, ws }) => {
        const get = async (endpoint: string, query: string) => {
          const r = await fetch(`${apiUrl}/api/workspaces/${ws}/analytics/${endpoint}${query}`, {
            credentials: "include",
          })
          return { status: r.status, body: await r.json().catch(() => null) }
        }
        const [dashboard, summary, log, spend] = await Promise.all([
          get("dashboard", "?period=30d&limit=50"),
          get("usage-summary", "?period=30d&page=1&limit=50"),
          get("usage-log", "?period=30d&page=1&limit=50"),
          get("spend-timeseries", "?period=30d&groupBy=model&metric=spend"),
        ])
        return { dashboard, summary, log, spend }
      },
      { apiUrl: API_URL, ws: workspaceId }
    )

    expect(result.dashboard.status).toBe(200)
    const data = result.dashboard.body?.data
    expect(data).toHaveProperty("summary")
    expect(data).toHaveProperty("timeseries")
    expect(data).toHaveProperty("usage")
    expect(data).toHaveProperty("logCount")
    expect(data.summary.totals).toHaveProperty("totalRequests")

    // Same numbers as the routes it replaced, read from the same rows.
    expect(data.summary.totals.totalRequests).toBe(
      result.summary.body?.data?.totals?.totalRequests
    )
    expect(data.summary.total).toBe(result.summary.body?.data?.total)
    expect(data.logCount).toBe(result.log.body?.data?.total)
    expect(data.timeseries.models).toEqual(result.spend.body?.data?.models)
    expect(data.timeseries.days.length).toBe(result.spend.body?.data?.days?.length)
  })

  test("API analytics dashboard refuses another workspace", async () => {
    const status = await page.evaluate(
      async (apiUrl) => {
        const r = await fetch(
          `${apiUrl}/api/workspaces/ws_not_mine/analytics/dashboard?period=30d`,
          { credentials: "include" }
        )
        return r.status
      },
      API_URL
    )
    expect([403, 404]).toContain(status)
  })
})
