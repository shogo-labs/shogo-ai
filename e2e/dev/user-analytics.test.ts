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
 * NOTE: The /settings URL resolves to the admin route group due to an
 * Expo Router conflict between (admin)/settings.tsx and (app)/settings.tsx.
 * We navigate to workspace settings via the Command Palette instead.
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

  await page.waitForSelector("text=What's on your mind", { timeout: 30_000 })
}

async function navigateToSettingsAnalytics(page: Page) {
  await page.keyboard.press("Meta+k")
  await page.waitForSelector("text=Workspace Analytics", { timeout: 5_000 })
  await page.getByText("Workspace Analytics").click()
  await page.waitForSelector("text=Workspace Analytics", { timeout: 15_000 })
}

test.describe("User Analytics", () => {
  test.describe.configure({ mode: "serial" })

  const TEST_USER = makeTestUser()
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  // ── Settings: Analytics Tab ─────────────────────────────────────────────

  test("workspace analytics tab is accessible via command palette", async () => {
    await navigateToSettingsAnalytics(page)

    await expect(page.getByText("Workspace Analytics").first()).toBeVisible()
    await expect(
      page.getByText("Usage metrics and credit consumption")
    ).toBeVisible()
  })

  test("workspace analytics shows period selector", async () => {
    await expect(page.getByText("7 days")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText("30 days")).toBeVisible()
    await expect(page.getByText("90 days")).toBeVisible()
    await expect(page.getByText("1 year")).toBeVisible()
  })

  test("workspace analytics shows stat cards", async () => {
    await expect(page.getByText("Members")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("Projects")).toBeVisible()
    await expect(page.getByText("Sessions", { exact: true })).toBeVisible()
    await expect(page.getByText("Usage Events")).toBeVisible()
  })

  test("workspace analytics shows AI Usage by User table", async () => {
    await expect(page.getByText("AI Usage by User")).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText("Summary")).toBeVisible()
    await expect(page.getByText("Event Log")).toBeVisible()
  })

  test("workspace analytics shows chat analytics section", async () => {
    await expect(page.getByText("Chat Analytics")).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText("Total Sessions")).toBeVisible()
    await expect(page.getByText("Total Messages")).toBeVisible()
  })

  test("workspace analytics has Analytics tab in sidebar", async () => {
    const analyticsTab = page.getByText("Analytics", { exact: true })
    await expect(analyticsTab).toBeVisible({ timeout: 5_000 })
  })

  // ── Profile: Usage & Credits ────────────────────────────────────────────

  test("profile page shows Usage & Credits section", async () => {
    await page.goto("/profile")
    await page.waitForLoadState("networkidle")

    await expect(page.getByText("Profile")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Account Information")).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText("Usage & Credits")).toBeVisible({
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
    await expect(page.getByText("Credits Used")).toBeVisible()
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
    expect(response.data).toHaveProperty("totalCreditsConsumed")
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
})
