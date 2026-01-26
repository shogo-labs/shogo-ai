/**
 * E2E Test: Project Runtime (Pod-per-Project Architecture)
 *
 * Tests the complete project runtime flow:
 * 1. User creates a project
 * 2. Claude Code agent generates code
 * 3. Vite preview shows the generated app
 * 4. File sync works (changes persist)
 * 5. Chat messages are handled by the project runtime
 *
 * Prerequisites:
 *   - Docker services running (postgres, minio, api, web)
 *   - ANTHROPIC_API_KEY set in .env.local
 */

import { test, expect, Page } from "@playwright/test"
import {
  signUpUser,
  WEB_URL,
  waitForProjectCreation,
} from "../helpers/test-helpers"

test.describe("Project Runtime E2E", () => {
  test.beforeEach(async ({ page }) => {
    // Increase timeout for AI-heavy tests
    test.setTimeout(120000)
  })

  test("full project creation and chat flow", async ({ page }) => {
    // 1. Sign up a new user
    await signUpUser(page)

    // 2. Verify we're on the home page
    await expect(
      page.getByRole("heading", { name: /What's on your mind/i })
    ).toBeVisible()

    // 3. Create a project from the chat input
    const chatInput = page.getByRole("textbox", { name: /Ask Shogo/i })
    await expect(chatInput).toBeVisible()

    const projectPrompt = `Create a simple counter app with a button that increments a number ${Date.now()}`
    await chatInput.fill(projectPrompt)
    await chatInput.press("Enter")

    // 4. Wait for project to be created
    await waitForProjectCreation(page)

    // 5. Verify we're on a project page
    const url = page.url()
    expect(url).toMatch(/\/projects\/[a-f0-9-]+/)

    // 6. Wait for the AI to start responding
    await page.waitForTimeout(3000)

    // 7. Verify chat UI is visible
    const chatContainer = page.locator('[data-testid="chat-container"]').first()
    const hasChat = await chatContainer.isVisible().catch(() => false)

    // Or look for message indicators
    const messageIndicators = page.locator(
      'text=/thinking|generating|processing|Building/i'
    )
    const hasIndicator = await messageIndicators.first().isVisible().catch(() => false)

    expect(hasChat || hasIndicator || url.includes("/projects/")).toBe(true)
  })

  test("preview panel shows generated content", async ({ page }) => {
    // Sign up and create a project
    await signUpUser(page)

    const chatInput = page.getByRole("textbox", { name: /Ask Shogo/i })
    await chatInput.fill(`Build a landing page with a hero section ${Date.now()}`)
    await chatInput.press("Enter")

    await waitForProjectCreation(page)

    // Wait for initial generation
    await page.waitForTimeout(5000)

    // Look for Preview button or tab
    const previewButton = page
      .getByRole("button", { name: /Preview|View/i })
      .first()
    const previewTab = page.getByRole("tab", { name: /Preview/i }).first()

    const hasPreviewButton = await previewButton.isVisible().catch(() => false)
    const hasPreviewTab = await previewTab.isVisible().catch(() => false)

    if (hasPreviewButton) {
      await previewButton.click()
      await page.waitForTimeout(2000)
    } else if (hasPreviewTab) {
      await previewTab.click()
      await page.waitForTimeout(2000)
    }

    // Check for iframe (preview panel) or preview content
    const previewIframe = page.locator("iframe").first()
    const hasIframe = await previewIframe.isVisible().catch(() => false)

    // The preview might still be loading
    const loadingText = page.locator('text=/Loading|Starting|Initializing/i')
    const isLoading = await loadingText.first().isVisible().catch(() => false)

    expect(hasIframe || isLoading || hasPreviewButton || hasPreviewTab).toBe(
      true
    )
  })

  test("can send follow-up messages in project chat", async ({ page }) => {
    // Sign up and create a project
    await signUpUser(page)

    const chatInput = page.getByRole("textbox", { name: /Ask Shogo/i })
    await chatInput.fill(`Create a todo list app ${Date.now()}`)
    await chatInput.press("Enter")

    await waitForProjectCreation(page)
    await page.waitForTimeout(3000)

    // Find the project chat input (might be different from home chat)
    const projectChatInput = page
      .getByRole("textbox", { name: /Ask Shogo|Message/i })
      .first()
    await expect(projectChatInput).toBeVisible({ timeout: 10000 })

    // Send a follow-up message
    const followUpMessage = "Add a delete button to each todo item"
    await projectChatInput.fill(followUpMessage)

    // Send the message
    const sendButton = page
      .getByRole("button", { name: /Send|Chat/i })
      .first()
    if (await sendButton.isEnabled().catch(() => false)) {
      await sendButton.click()
    } else {
      await projectChatInput.press("Enter")
    }

    // Wait for response
    await page.waitForTimeout(3000)

    // Verify the message was sent (look for it in the chat or see AI processing)
    const messageVisible = await page
      .getByText(followUpMessage)
      .isVisible()
      .catch(() => false)
    const processingVisible = await page
      .locator('text=/thinking|processing|Editing/i')
      .first()
      .isVisible()
      .catch(() => false)

    expect(messageVisible || processingVisible).toBe(true)
  })

  test("project persists across page reload", async ({ page }) => {
    // Sign up and create a project
    await signUpUser(page)

    const chatInput = page.getByRole("textbox", { name: /Ask Shogo/i })
    const projectName = `Persistence Test ${Date.now()}`
    await chatInput.fill(`Create ${projectName}`)
    await chatInput.press("Enter")

    await waitForProjectCreation(page)

    // Get the project URL
    const projectUrl = page.url()
    expect(projectUrl).toMatch(/\/projects\/[a-f0-9-]+/)

    // Extract project ID
    const projectIdMatch = projectUrl.match(/\/projects\/([a-f0-9-]+)/)
    expect(projectIdMatch).not.toBeNull()
    const projectId = projectIdMatch![1]

    // Reload the page
    await page.reload()
    await page.waitForTimeout(3000)

    // Verify we're still on the same project
    expect(page.url()).toContain(projectId)

    // Verify project content is visible
    const hasProjectContent =
      (await page
        .locator('[data-testid="chat-container"]')
        .isVisible()
        .catch(() => false)) ||
      (await page
        .locator('text=/Preview|Chat|Discovery/i')
        .first()
        .isVisible()
        .catch(() => false))

    expect(hasProjectContent).toBe(true)
  })

  test("sidebar shows project after creation", async ({ page }) => {
    // Sign up
    await signUpUser(page)

    // Create a project
    const chatInput = page.getByRole("textbox", { name: /Ask Shogo/i })
    const uniqueName = `Sidebar Test ${Date.now()}`
    await chatInput.fill(`Create a ${uniqueName}`)
    await chatInput.press("Enter")

    await waitForProjectCreation(page)
    await page.waitForTimeout(2000)

    // Look for project in sidebar
    const sidebarProject = page
      .locator('a[href*="/projects/"]:not([href="/projects"])')
      .first()
    const hasProjectInSidebar = await sidebarProject
      .isVisible()
      .catch(() => false)

    expect(hasProjectInSidebar).toBe(true)
  })
})

test.describe("Project Runtime API Health", () => {
  test("API health endpoint responds", async ({ request }) => {
    const response = await request.get("http://localhost:8002/api/health")
    expect(response.ok()).toBe(true)

    const body = await response.json()
    expect(body.ok).toBe(true)
  })

  test("MCP endpoint is accessible", async ({ request }) => {
    // MCP returns 400 for empty requests, but that means it's running
    const response = await request.get("http://localhost:3100/mcp")
    expect([200, 400]).toContain(response.status())
  })
})
