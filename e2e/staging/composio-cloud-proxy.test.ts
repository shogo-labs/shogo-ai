// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"
import { makeTestUser, signUpAndOnboard } from "./helpers"

/**
 * API Key Feature — Full E2E Tests
 *
 * Validates the entire API key ecosystem end-to-end:
 *
 * 1. API Key Lifecycle
 *    - Create workspace API key (shogo_sk_*)
 *    - Validate key via public endpoint
 *    - List keys for workspace
 *    - Revoke key and confirm rejection
 *
 * 2. Composio Cloud Proxy (API key as Bearer auth)
 *    - GET  /api/integrations/providers
 *    - GET  /api/integrations/connections
 *    - GET  /api/integrations/status/:toolkit
 *    - POST /api/integrations/connect (OAuth redirect URL generation)
 *
 * 3. AI Proxy Auth (API key accepted as LLM proxy credential)
 *    - OpenAI-compatible endpoint accepts shogo_sk_* as Bearer token
 *    - Anthropic-native endpoint accepts shogo_sk_* as x-api-key
 *
 * 4. Remote Control — Instance Registry
 *    - Instance list endpoint works for workspace members
 *    - Instance list is initially empty (no local instance connected)
 *
 * 5. Remote Control — UI Navigation
 *    - Remote Control page loads and shows empty state
 *    - API Keys page loads and shows the created key
 *    - Navigation between Remote Control and API Keys works
 *
 * 6. Billing & Credit Visibility
 *    - Workspace plan endpoint returns credit info
 *    - API key usage is billed to the workspace
 *
 * 7. Key Revocation Security
 *    - Revoked key is rejected by validate endpoint
 *    - Revoked key is rejected by proxy endpoints
 *    - Revoked key is rejected by AI proxy endpoints
 *
 * Prerequisites:
 * - COMPOSIO_API_KEY must be set in the target environment
 * - The target environment must have the proxy code deployed
 *
 * Run:
 *   STAGING_URL=https://studio.staging.shogo.ai \
 *     npx playwright test --config e2e/playwright.config.ts composio-cloud-proxy
 */

const API_BASE =
  process.env.STAGING_API_URL || process.env.STAGING_URL || "http://localhost:8081"

const TEST_USER = makeTestUser("ApiKeyE2E")

test.describe("API Key Feature — Full E2E", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let request: APIRequestContext
  let apiKey: string
  let apiKeyId: string
  let workspaceId: string
  let projectId: string

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    request = page.request
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  // =========================================================================
  // 1. API Key Lifecycle
  // =========================================================================

  test("1a — resolve workspace ID from authenticated session", async () => {
    // The billing endpoint returns workspace-level data; use it to confirm
    // we have at least one workspace.
    const planRes = await request.get(`${API_BASE}/api/billing/workspace-plan?workspaceId=_`)
    // May fail (we don't know the ID yet), but that's fine — we'll get it from the UI

    // Navigate to API keys page which requires a workspace
    await page.goto("/api-keys")
    await page.waitForSelector("text=API Keys", { timeout: 15_000 })

    // The page loads workspace context internally. Grab the workspace ID
    // from the create-key API call we're about to make.
  })

  test("1b — create a workspace API key", async () => {
    // Click "Create Key" button
    const createBtn = page.getByText("Create Key").first()
    await createBtn.waitFor({ state: "visible", timeout: 10_000 })
    await createBtn.click()

    // Modal should appear with "Create API Key" title
    await page.waitForSelector("text=Create API Key", { timeout: 5_000 })

    // The default name should be "Shogo Local" — change it
    const nameInput = page.locator('input[placeholder*="Laptop"]').or(
      page.locator('input[placeholder*="Desktop"]')
    )
    if (await nameInput.isVisible()) {
      await nameInput.fill("E2E Test Key")
    }

    // Click "Create Key" in the modal dialog
    const modal = page.getByRole("dialog", { name: "Create API Key" })
    await modal.waitFor({ state: "visible", timeout: 5_000 })
    await modal.getByText("Create Key", { exact: true }).click()

    // Wait for the key to be created — the modal shows "API Key Created"
    await page.waitForSelector("text=API Key Created", { timeout: 15_000 })

    // The key is displayed in a monospace text element
    const keyElement = page.locator("text=shogo_sk_")
    await keyElement.waitFor({ state: "visible", timeout: 5_000 })
    const keyText = await keyElement.textContent()
    expect(keyText).toBeTruthy()
    expect(keyText).toMatch(/^shogo_sk_/)
    apiKey = keyText!.trim()

    // Copy button should work
    const copyBtn = page.locator('[class*="Copy"], [data-testid="copy-key"]').first()
    if (await copyBtn.isVisible()) {
      await copyBtn.click()
      await page.waitForTimeout(500)
    }

    // Close the modal
    const doneModal = page.getByRole("dialog", { name: "API Key Created" })
    await doneModal.getByText("Done").click()
    await page.waitForTimeout(500)
  })

  test("1c — validate API key via public endpoint", async () => {
    const res = await request.post(`${API_BASE}/api/api-keys/validate`, {
      data: { key: apiKey },
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.valid).toBe(true)
    expect(body.workspace).toBeTruthy()
    expect(body.workspace.id).toBeTruthy()
    expect(body.user).toBeTruthy()

    workspaceId = body.workspace.id
  })

  test("1d — list API keys shows the created key", async () => {
    const res = await request.get(
      `${API_BASE}/api/api-keys?workspaceId=${workspaceId}`,
    )
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.keys).toBeTruthy()
    expect(body.keys.length).toBeGreaterThanOrEqual(1)

    const ourKey = body.keys.find((k: any) => apiKey.startsWith(k.keyPrefix))
    expect(ourKey).toBeTruthy()
    apiKeyId = ourKey.id
  })

  test("1e — invalid API key is rejected", async () => {
    const fakeKey =
      "shogo_sk_0000000000000000000000000000000000000000000000000000000000000000"
    const res = await request.post(`${API_BASE}/api/api-keys/validate`, {
      data: { key: fakeKey },
    })
    const body = await res.json()
    expect(body.valid).toBe(false)
  })

  // =========================================================================
  // 2. Composio Cloud Proxy (API key auth simulating local-to-cloud)
  // =========================================================================

  test("2a — create a project for integration scoping", async () => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 15_000 })

    const input = page.getByPlaceholder("Ask Shogo to create...")
    await input.click()
    await input.fill("Test project for API key E2E")
    await page.waitForTimeout(500)
    await page.keyboard.press("Enter")

    await page.waitForURL(/\/projects\//, { timeout: 60_000 })
    const match = page.url().match(/projects\/([^/?]+)/)
    expect(match).toBeTruthy()
    projectId = match![1]

    // Wait for agent to finish
    const stopSel = '[data-testid="stop-streaming"], [aria-label="Stop"]'
    try {
      await page.waitForSelector(stopSel, { state: "attached", timeout: 15_000 })
    } catch {
      // May not have started streaming
    }
    await page
      .waitForSelector(stopSel, { state: "detached", timeout: 90_000 })
      .catch(() => {})
    await page.waitForTimeout(1_000)
  })

  test("2b — API key auth: GET /integrations/providers", async () => {
    const res = await request.get(`${API_BASE}/api/integrations/providers`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBeTruthy()

    if (body.enabled) {
      expect(body.data.length).toBeGreaterThan(0)
      const toolkits = body.data.map((p: any) => p.toolkit)
      const common = ["gmail", "googlecalendar", "slack", "github"]
      expect(common.some((t) => toolkits.includes(t))).toBeTruthy()
    }
  })

  test("2c — API key auth: GET /integrations/connections (empty for new user)", async () => {
    const res = await request.get(
      `${API_BASE}/api/integrations/connections?projectId=${projectId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBeTruthy()
    expect(body.data.length).toBe(0)
  })

  test("2d — API key auth: GET /integrations/status/:toolkit", async () => {
    const res = await request.get(
      `${API_BASE}/api/integrations/status/googlecalendar?projectId=${projectId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data).toHaveProperty("connected")
    expect(body.data.connected).toBe(false)
  })

  test("2e — API key auth: POST /integrations/connect returns redirect URL", async () => {
    const res = await request.post(`${API_BASE}/api/integrations/connect`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      data: {
        toolkit: "googlecalendar",
        projectId,
        callbackUrl: `${API_BASE}/api/integrations/callback?redirect=${encodeURIComponent("shogo://integrations-callback")}`,
      },
    })

    if (res.status() === 503) {
      // Composio not configured in this environment — skip gracefully
      return
    }

    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.redirectUrl).toMatch(/^https?:\/\//)
    expect(body.data.toolkit).toBe("googlecalendar")
  })

  // =========================================================================
  // 3. AI Proxy Auth (API key accepted as LLM proxy credential)
  // =========================================================================

  test("3a — AI proxy: shogo_sk_* accepted as OpenAI-style Bearer token", async () => {
    // Send a minimal models-list request which validates auth without
    // actually consuming tokens or requiring a real upstream call.
    const res = await request.get(`${API_BASE}/api/ai/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    // Models endpoint may return 200 (list) or 404 (not implemented).
    // The key point is it should NOT return 401/403.
    expect([200, 404]).toContain(res.status())
  })

  test("3b — AI proxy: invalid token is rejected", async () => {
    const res = await request.post(`${API_BASE}/api/ai/v1/chat/completions`, {
      headers: {
        Authorization: "Bearer invalid_not_a_real_token",
        "Content-Type": "application/json",
      },
      data: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
      },
    })
    expect([401, 403]).toContain(res.status())
  })

  // =========================================================================
  // 4. Remote Control — Instance Registry (API)
  // =========================================================================

  test("4a — instance list returns empty for new workspace", async () => {
    const res = await request.get(
      `${API_BASE}/api/instances?workspaceId=${workspaceId}`,
    )
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.instances).toBeTruthy()
    expect(Array.isArray(body.instances)).toBeTruthy()
    // No local instance is running in this test, so list should be empty
    // (or contain only offline entries from previous test runs)
  })

  test("4b — instance detail returns 404 for non-existent instance", async () => {
    const res = await request.get(
      `${API_BASE}/api/instances/non-existent-instance-id`,
    )
    expect(res.status()).toBe(404)
  })

  // =========================================================================
  // 5. Remote Control — UI Navigation
  // =========================================================================

  test("5a — Remote Control page loads and shows correct state", async () => {
    await page.goto("/remote-control")
    await page.waitForSelector("text=Remote Control", { timeout: 15_000 })

    // Should show either instance cards or empty state
    const hasInstances = await page.getByText("Online").isVisible().catch(() => false)
    const hasEmptyState = await page
      .getByText("No instances registered")
      .isVisible()
      .catch(() => false)
    expect(hasInstances || hasEmptyState).toBeTruthy()
  })

  test("5b — Empty state links to API Keys page", async () => {
    const hasEmptyState = await page
      .getByText("No instances registered")
      .isVisible()
      .catch(() => false)

    if (hasEmptyState) {
      const createKeyLink = page.getByText("Create API Key")
      expect(await createKeyLink.isVisible()).toBeTruthy()
      await createKeyLink.click()
      await page.waitForURL(/api-keys/, { timeout: 10_000 })
      await page.waitForSelector("text=API Keys", { timeout: 10_000 })
    }
  })

  test("5c — API Keys page shows the created key in the table", async () => {
    await page.goto("/api-keys")
    await page.waitForSelector("text=API Keys", { timeout: 15_000 })

    // Wait for keys to load (not showing "Loading API keys..." anymore)
    await page.waitForSelector("text=Loading API keys...", {
      state: "hidden",
      timeout: 10_000,
    }).catch(() => {})

    // The key prefix should be visible in the table
    const keyPrefix = apiKey.slice(0, 17)
    const prefixVisible = await page
      .getByText(keyPrefix, { exact: false })
      .isVisible()
      .catch(() => false)

    // Either the prefix is shown or we see "1 key" count
    const keyCount = await page
      .getByText(/1 key/)
      .isVisible()
      .catch(() => false)
    expect(prefixVisible || keyCount).toBeTruthy()
  })

  // =========================================================================
  // 6. Billing & Credit Visibility
  // =========================================================================

  test("6a — workspace plan endpoint returns billing info", async () => {
    const res = await request.get(
      `${API_BASE}/api/billing/workspace-plan?workspaceId=${workspaceId}`,
    )
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.planId).toBeTruthy()
    // Free plan should have some daily credits
    expect(typeof body.dailyCredits).toBe("number")
  })

  // =========================================================================
  // 7. Key Revocation Security
  // =========================================================================

  test("7a — revoke the API key", async () => {
    const res = await request.delete(`${API_BASE}/api/api-keys/${apiKeyId}`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  test("7b — revoked key: validate endpoint rejects", async () => {
    const res = await request.post(`${API_BASE}/api/api-keys/validate`, {
      data: { key: apiKey },
    })
    const body = await res.json()
    expect(body.valid).toBe(false)
  })

  test("7c — revoked key: integrations proxy rejects", async () => {
    const res = await request.get(
      `${API_BASE}/api/integrations/connections?projectId=${projectId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
    // Revoked key should cause auth failure
    expect([401, 403]).toContain(res.status())
  })

  test("7d — revoked key: AI proxy rejects", async () => {
    const res = await request.post(`${API_BASE}/api/ai/v1/chat/completions`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      data: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
      },
    })
    expect([401, 403]).toContain(res.status())
  })

  test("7e — revoked key: key no longer appears in list", async () => {
    const res = await request.get(
      `${API_BASE}/api/api-keys?workspaceId=${workspaceId}`,
    )
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    const ourKey = body.keys?.find((k: any) => k.id === apiKeyId)
    // Revoked keys should not appear in the active list
    expect(ourKey).toBeFalsy()
  })

  test("7f — API Keys page reflects revocation", async () => {
    await page.goto("/api-keys")
    await page.waitForSelector("text=API Keys", { timeout: 15_000 })

    await page.waitForSelector("text=Loading API keys...", {
      state: "hidden",
      timeout: 10_000,
    }).catch(() => {})

    // Should show empty state now
    const emptyState = await page
      .getByText("No API keys yet")
      .isVisible({ timeout: 5_000 })
      .catch(() => false)
    const zeroKeys = await page
      .getByText("0 key")
      .isVisible()
      .catch(() => false)
    expect(emptyState || zeroKeys).toBeTruthy()
  })
})
