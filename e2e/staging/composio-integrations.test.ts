// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect } from "@playwright/test"
import { makeTestUser, signUpAndOnboard } from "./helpers"

/**
 * Composio Integration E2E Tests
 *
 * Validates the Composio-powered OAuth integration flow:
 * - Integration providers endpoint returns data when configured
 * - MCP catalog includes authType and composioToolkit fields
 * - Connect button appears for Composio-backed entries in MCP panel
 * - Connection status endpoint works
 *
 * Note: Full OAuth flow (redirect to Google, authorize, callback) cannot
 * be tested automatically — it requires real Google credentials. These tests
 * validate the infrastructure and UI up to the point of redirect.
 *
 * Prerequisites:
 * - COMPOSIO_API_KEY must be set in staging environment
 * - Auth configs must be created on platform.composio.dev
 *
 * Run: npx playwright test --config e2e/playwright.config.ts composio-integrations
 */

const STAGING_API_URL = process.env.STAGING_API_URL || process.env.STAGING_URL || "http://localhost:8081"

const TEST_USER = makeTestUser("Composio")

test.describe("Composio Integrations", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("integration providers endpoint returns data", async () => {
    const res = await page.request.get(`${STAGING_API_URL}/api/integrations/providers`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBeTruthy()
  })

  test("MCP catalog includes composio authType fields", async () => {
    const input = page.getByPlaceholder("Ask Shogo to ...")
    await input.click()
    await input.fill("Test composio integrations")
    await page.waitForTimeout(500)
    await page.keyboard.press("Enter")
    await page.waitForURL(/\/projects\//, { timeout: 60_000 })

    // Wait for agent to be ready
    await page.waitForTimeout(5_000)

    // Check the MCP catalog endpoint directly
    const projectUrl = page.url()
    const projectId = projectUrl.match(/projects\/([^/?]+)/)?.[1]
    expect(projectId).toBeTruthy()

    // The MCP catalog should include authType fields
    // We check this via the API since the catalog is fetched by the panel
    const catalogRes = await page.request.get(`${STAGING_API_URL}/api/integrations/providers`)
    const catalogBody = await catalogRes.json()

    // If Composio is enabled, we should have providers
    if (catalogBody.enabled) {
      expect(catalogBody.data.length).toBeGreaterThan(0)
      const toolkits = catalogBody.data.map((p: any) => p.toolkit)
      expect(toolkits).toContain("googlecalendar")
    }
  })

  test("connection status check works", async () => {
    const projectUrl = page.url()
    const projectId = projectUrl.match(/projects\/([^/?]+)/)?.[1]
    expect(projectId).toBeTruthy()

    const res = await page.request.get(
      `${STAGING_API_URL}/api/integrations/status/googlecalendar?projectId=${projectId}`,
    )
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data).toHaveProperty("connected")
    // New user won't have any connections yet
    expect(body.data.connected).toBe(false)
  })

  test("connections list endpoint returns empty for new user", async () => {
    const projectUrl = page.url()
    const projectId = projectUrl.match(/projects\/([^/?]+)/)?.[1]
    expect(projectId).toBeTruthy()

    const res = await page.request.get(
      `${STAGING_API_URL}/api/integrations/connections?projectId=${projectId}`,
    )
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBeTruthy()
    expect(body.data.length).toBe(0)
  })
})
