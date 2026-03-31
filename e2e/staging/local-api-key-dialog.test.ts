import { test, expect } from "@playwright/test"

/**
 * Local-mode test for API Key dialog accessibility and integrations endpoints.
 * 
 * Run:
 *   STAGING_URL=http://localhost:8081 \
 *     npx playwright test --config e2e/playwright.config.ts local-api-key-dialog
 */

const API_BASE = process.env.STAGING_API_URL || "http://localhost:8002"

test.describe("Local Mode — API Key Dialog & Integrations", () => {
  test.describe.configure({ mode: "serial" })

  test("auto-sign-in and navigate to home", async ({ page }) => {
    await page.goto("/")
    // Local mode auto-signs in — wait for home or sign-in redirect
    const signedIn = await page.waitForSelector("text=What's on your mind", { timeout: 20_000 }).catch(() => null)
    if (!signedIn) {
      // May need to trigger auto-sign-in
      await page.goto("/sign-in")
      await page.waitForTimeout(3_000)
      await page.goto("/")
      await page.waitForSelector("text=What's on your mind", { timeout: 20_000 })
    }
  })

  test("API Keys page loads", async ({ page }) => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 15_000 })
    await page.goto("/api-keys")
    await page.waitForSelector("text=API Keys", { timeout: 15_000 })
  })

  test("Create Key modal has role='dialog'", async ({ page }) => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 15_000 })
    await page.goto("/api-keys")
    await page.waitForSelector("text=API Keys", { timeout: 15_000 })

    // Click "+ Create Key" button in the header
    const createBtn = page.getByText("Create Key").first()
    await createBtn.waitFor({ state: "visible", timeout: 10_000 })
    await createBtn.click()

    // Modal should appear with "Create API Key" title
    await page.waitForSelector("text=Create API Key", { timeout: 5_000 })

    // Verify the dialog role is set
    const dialog = page.getByRole("dialog", { name: "Create API Key" })
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // Verify we can find the "Create Key" button inside the dialog
    const confirmBtn = dialog.getByText("Create Key", { exact: true })
    await expect(confirmBtn).toBeVisible()

    // Verify Cancel button is also in the dialog
    const cancelBtn = dialog.getByText("Cancel")
    await expect(cancelBtn).toBeVisible()

    // Click Cancel to close
    await cancelBtn.click()
    await expect(dialog).toBeHidden({ timeout: 3_000 })
  })

  test("Create Key modal button is clickable via dialog selector", async ({ page }) => {
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 15_000 })
    await page.goto("/api-keys")
    await page.waitForSelector("text=API Keys", { timeout: 15_000 })

    // Open modal
    await page.getByText("Create Key").first().click()
    await page.waitForSelector("text=Create API Key", { timeout: 5_000 })

    const dialog = page.getByRole("dialog", { name: "Create API Key" })
    await expect(dialog).toBeVisible()

    // Fill in key name
    const nameInput = dialog.locator("input")
    await nameInput.clear()
    await nameInput.fill("Local E2E Test Key")

    // Click Create Key inside the dialog
    await dialog.getByText("Create Key", { exact: true }).click()

    // Should transition to "API Key Created" state or show error (no cloud DB in local mode is fine)
    // We're just testing that the click goes through
    await page.waitForTimeout(2_000)

    // Check if we got the success dialog or an error
    const createdDialog = page.getByRole("dialog", { name: "API Key Created" })
    const hasCreated = await createdDialog.isVisible().catch(() => false)

    if (hasCreated) {
      // Key was created — verify the key is shown
      const keyText = await createdDialog.locator("text=shogo_sk_").textContent().catch(() => null)
      expect(keyText).toBeTruthy()

      // Close with Done
      await createdDialog.getByText("Done").click()
      await expect(createdDialog).toBeHidden({ timeout: 3_000 })
    }
    // If not created (local mode may not support it), that's OK — we verified the click worked
  })

  test("GET /api/integrations/providers works without auth", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/integrations/providers`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data)).toBeTruthy()
  })

  test("GET /api/integrations/connections returns 401 without auth", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/integrations/connections?projectId=test`)
    expect(res.status()).toBe(401)
  })

  test("GET /api/integrations/status/:toolkit returns 401 without auth", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/integrations/status/github?projectId=test`)
    expect(res.status()).toBe(401)
  })

  test("GET /api/health returns ok", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/health`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  test("GET /api/config returns localMode", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/config`)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.localMode).toBe(true)
  })
})
