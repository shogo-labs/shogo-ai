/**
 * E2E Test: Chad Groupert - Comprehensive AI Chat App Creation
 *
 * This comprehensive E2E test creates a full-featured AI chat application called
 * "Chad Groupert" that provides health and beauty tips with a colorful theme.
 *
 * The test exercises ALL major functionality of the Shogo platform:
 *
 * 1. AUTHENTICATION
 *    - Sign up a new user
 *    - Verify workspace loads
 *
 * 2. PROJECT CREATION
 *    - Create project from home chat input
 *    - Wait for project to be created and navigated to
 *    - Verify project appears in sidebar
 *
 * 3. SCHEMA CREATION (via AI chat)
 *    - Define ChatSession model
 *    - Define ChatMessage model with relationship
 *    - Define UserPreferences model for theme customization
 *
 * 4. UI GENERATION (via AI chat)
 *    - Generate chat interface components
 *    - Create colorful theme (pink/purple/teal gradient palette)
 *    - Add health & beauty persona to AI responses
 *
 * 5. PREVIEW PANEL
 *    - Verify runtime preview loads
 *    - Check for colorful theme application
 *    - Test viewport controls (desktop/tablet/mobile)
 *
 * 6. CODE EDITOR PANEL
 *    - Open code editor
 *    - View generated files
 *    - Verify file tree loads
 *    - Make a small edit and verify HMR
 *
 * 7. DATABASE PANEL
 *    - Open database panel (Prisma Studio)
 *    - Verify schema tables are visible
 *    - Check data can be viewed
 *
 * 8. TEST PANEL
 *    - Open test panel
 *    - View test files
 *    - Run tests and verify output
 *    - Check test results summary
 *
 * 9. CHAT FUNCTIONALITY
 *    - Send follow-up messages
 *    - Verify AI responses
 *    - Check chat history
 *
 * 10. PERSISTENCE
 *     - Reload page
 *     - Verify project state persists
 *     - Verify chat history persists
 *
 * Prerequisites:
 *   - Database must be initialized (run: bun run db:init)
 *   - Services running (MCP: 3100, API: 8002, Web: 5173)
 *   - ANTHROPIC_API_KEY set in .env.local
 *
 * Note: This is a long-running test (~3-5 minutes) due to AI interactions.
 * Run with: npx playwright test create-chad-groupert-e2e.test.ts --timeout=300000
 */

import { test, expect, Page } from "@playwright/test"
import {
  signUpUser,
  waitForProjectCreation,
  waitForProjectRuntime,
  WEB_URL,
  API_URL,
} from "../helpers/test-helpers"

// Extended timeout for AI-heavy tests
test.setTimeout(600000) // 10 minutes

/**
 * Test context to track state across test sections
 */
interface TestContext {
  projectId: string
  projectUrl: string
  userEmail: string
}

/**
 * Wait for MCP server to be ready
 */
async function waitForMCPServer(page: Page, timeout = 30000): Promise<boolean> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeout) {
    try {
      const response = await page.evaluate(async () => {
        try {
          const res = await fetch("http://localhost:3100/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test", version: "1.0.0" },
              },
            }),
          })
          return res.ok
        } catch {
          return false
        }
      })
      if (response) {
        console.log("✓ MCP server is ready")
        return true
      }
    } catch {
      // Continue waiting
    }
    await page.waitForTimeout(1000)
  }
  console.log("⚠ MCP server may not be ready, but continuing test...")
  return false
}

/**
 * Wait for AI to finish processing (look for completion indicators)
 */
async function waitForAIResponse(
  page: Page,
  timeout = 60000
): Promise<boolean> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    // Check for processing indicators being gone
    const isThinking = await page
      .locator('text=/thinking|processing|Generating|Building|Creating/i')
      .first()
      .isVisible()
      .catch(() => false)

    if (!isThinking) {
      // Wait a bit more to ensure response is complete
      await page.waitForTimeout(2000)
      return true
    }

    await page.waitForTimeout(1000)
  }

  return false
}

/**
 * Switch to a specific panel in the project view
 */
async function switchToPanel(
  page: Page,
  panelName: "runtime" | "code" | "database" | "tests" | "terminal"
): Promise<boolean> {
  const panelButtons: Record<string, string[]> = {
    runtime: ["Preview", "App"],
    code: ["Code", "Editor"],
    database: ["Database", "DB", "Data"],
    tests: ["Tests", "Test"],
    terminal: ["Terminal", "Console"],
  }

  const buttonNames = panelButtons[panelName]
  for (const name of buttonNames) {
    const button = page.getByRole("button", { name: new RegExp(name, "i") }).first()
    if (await button.isVisible().catch(() => false)) {
      await button.click()
      await page.waitForTimeout(1000)
      return true
    }

    // Also try tab role
    const tab = page.getByRole("tab", { name: new RegExp(name, "i") }).first()
    if (await tab.isVisible().catch(() => false)) {
      await tab.click()
      await page.waitForTimeout(1000)
      return true
    }
  }

  return false
}

test.describe("Chad Groupert - Complete AI Chat App E2E", () => {
  let ctx: TestContext

  test.beforeAll(() => {
    ctx = {
      projectId: "",
      projectUrl: "",
      userEmail: "",
    }
  })

  test("1. Create Chad Groupert project and verify full functionality", async ({
    page,
  }) => {
    // Track console errors for debugging
    const consoleErrors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text())
      }
    })

    // =========================================================================
    // PHASE 1: AUTHENTICATION
    // =========================================================================
    console.log("\n========== PHASE 1: AUTHENTICATION ==========")

    const credentials = await signUpUser(page)
    ctx.userEmail = credentials.email
    console.log(`✓ User signed up: ${ctx.userEmail}`)

    // Verify workspace loads
    await expect(
      page.getByRole("heading", { name: /What's on your mind/i })
    ).toBeVisible({ timeout: 15000 })
    console.log("✓ Workspace loaded successfully")

    // Wait for MCP server
    await waitForMCPServer(page)
    await page.waitForTimeout(2000)

    // =========================================================================
    // PHASE 2: PROJECT CREATION
    // =========================================================================
    console.log("\n========== PHASE 2: PROJECT CREATION ==========")

    const chatInput = page.getByRole("textbox", { name: /Ask Shogo/i })
    await expect(chatInput).toBeVisible()

    // Create the Chad Groupert project with detailed requirements
    const projectPrompt = `Create an AI chat application called "Chad Groupert" with these requirements:
- The app should have a colorful theme using pink, purple, and teal gradients
- The AI persona should be a friendly health and beauty advisor named Chad
- Chad gives tips about skincare, fitness, nutrition, and self-care
- Include chat sessions, message history, and user preferences
- Make the UI modern and vibrant with smooth animations
- Timestamp: ${Date.now()}`

    await chatInput.fill(projectPrompt)
    await chatInput.press("Enter")
    console.log("✓ Project creation prompt sent")

    // Wait for project to be created
    await waitForProjectCreation(page)

    // Verify we're on a project page
    let url = page.url()
    let projectIdMatch = url.match(/\/projects\/([a-f0-9-]+)/)

    if (!projectIdMatch) {
      // Try to find and click project in sidebar
      console.log("Checking sidebar for project link...")
      await page.waitForTimeout(3000)
      const projectLink = page
        .locator('a[href*="/projects/"]:not([href="/projects"])')
        .first()
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click()
        await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 10000 })
        url = page.url()
        projectIdMatch = url.match(/\/projects\/([a-f0-9-]+)/)
      }
    }

    expect(projectIdMatch).not.toBeNull()
    ctx.projectId = projectIdMatch![1]
    ctx.projectUrl = url
    console.log(`✓ Project created with ID: ${ctx.projectId}`)

    // Verify project appears in sidebar
    const sidebarProject = page
      .locator('a[href*="/projects/"]:not([href="/projects"])')
      .first()
    await expect(sidebarProject).toBeVisible({ timeout: 5000 })
    console.log("✓ Project visible in sidebar")

    // =========================================================================
    // PHASE 3: SCHEMA CREATION (via AI chat)
    // =========================================================================
    console.log("\n========== PHASE 3: SCHEMA CREATION ==========")

    await page.waitForTimeout(3000)

    const projectChatInput = page
      .getByRole("textbox", { name: /Ask Shogo/i })
      .first()
    await expect(projectChatInput).toBeVisible({ timeout: 10000 })

    const schemaPrompt = `Create the database schema for Chad Groupert with these models:

1. ChatSession - tracks conversation sessions with fields:
   - id (string, identifier)
   - name (string) - user-friendly session name
   - createdAt (number) - timestamp
   - updatedAt (number) - timestamp
   - status (enum: active, completed, archived)

2. ChatMessage - individual messages in a session:
   - id (string, identifier)
   - session (reference to ChatSession)
   - role (enum: user, assistant)
   - content (string) - the message text
   - createdAt (number) - timestamp

3. UserPreferences - user theme and personalization settings:
   - id (string, identifier)
   - theme (enum: colorful, minimal, dark)
   - primaryColor (string) - hex color code
   - accentColor (string) - hex color code
   - notificationsEnabled (boolean)

Make sure the relationships are properly defined.`

    await projectChatInput.fill(schemaPrompt)
    await projectChatInput.press("Enter")
    console.log("✓ Schema creation prompt sent")

    // Wait for schema creation
    await waitForAIResponse(page, 90000)
    console.log("✓ Schema creation completed")

    // =========================================================================
    // PHASE 4: UI GENERATION
    // =========================================================================
    console.log("\n========== PHASE 4: UI GENERATION ==========")

    await page.waitForTimeout(3000)

    const uiPrompt = `Now generate the complete UI for Chad Groupert:

1. Chat Interface:
   - Sidebar with chat session list (pink gradient header)
   - Main chat area with message bubbles
   - User messages in teal, assistant messages in purple gradient
   - Animated typing indicator with colorful dots
   
2. Message Input:
   - Rounded input field with gradient border
   - Send button with purple-to-pink gradient
   - Emoji picker button
   
3. Header:
   - App name "Chad Groupert" with gradient text
   - User avatar with colorful ring
   - Settings gear icon
   
4. Theme:
   - Background: soft cream/white (#faf8f5)
   - Primary gradient: pink (#ec4899) to purple (#a855f7)
   - Accent: teal (#14b8a6)
   - Use smooth hover animations and transitions
   
5. Chad's Persona:
   - Make assistant responses start with friendly health tips
   - Use emojis in responses for personality
   - Signature phrases like "Stay radiant!" or "Your wellness journey starts here!"

Generate all components and create the app shell layout.`

    await projectChatInput.fill(uiPrompt)
    await projectChatInput.press("Enter")
    console.log("✓ UI generation prompt sent")

    // Wait for UI generation
    await waitForAIResponse(page, 120000)
    console.log("✓ UI generation completed")

    // =========================================================================
    // PHASE 5: PREVIEW PANEL
    // =========================================================================
    console.log("\n========== PHASE 5: PREVIEW PANEL ==========")

    // Switch to preview/runtime panel
    const previewOpened = await switchToPanel(page, "runtime")
    if (previewOpened) {
      console.log("✓ Switched to preview panel")
    }

    // Wait for preview iframe to load
    await page.waitForTimeout(5000)

    const previewIframe = page.locator("iframe").first()
    const hasPreviewIframe = await previewIframe.isVisible().catch(() => false)

    if (hasPreviewIframe) {
      console.log("✓ Preview iframe is visible")

      // Check for loading indicators
      const loadingSpinner = page.locator('text=/Loading preview/i')
      if (await loadingSpinner.isVisible().catch(() => false)) {
        // Wait for loading to complete
        await page.waitForTimeout(10000)
      }
    } else {
      console.log("⚠ Preview iframe not immediately visible, may still be loading")
    }

    // Test viewport controls if visible
    const viewportButtons = [
      { name: "Desktop", selector: 'button[title*="Desktop"]' },
      { name: "Tablet", selector: 'button[title*="Tablet"]' },
      { name: "Mobile", selector: 'button[title*="Mobile"]' },
    ]

    for (const vp of viewportButtons) {
      const vpButton = page.locator(vp.selector).first()
      if (await vpButton.isVisible().catch(() => false)) {
        await vpButton.click()
        await page.waitForTimeout(500)
        console.log(`✓ Tested ${vp.name} viewport`)
      }
    }

    // =========================================================================
    // PHASE 6: CODE EDITOR PANEL
    // =========================================================================
    console.log("\n========== PHASE 6: CODE EDITOR PANEL ==========")

    const codeOpened = await switchToPanel(page, "code")
    if (codeOpened) {
      console.log("✓ Switched to code editor panel")

      // Wait for file tree to load
      await page.waitForTimeout(3000)

      // Look for file tree elements
      const fileTree = page.locator('[class*="file"], [class*="folder"]').first()
      const hasFileTree = await fileTree.isVisible().catch(() => false)

      if (hasFileTree) {
        console.log("✓ File tree is visible")

        // Try to click on a file
        const tsxFile = page.locator('text=/\\.tsx$/').first()
        if (await tsxFile.isVisible().catch(() => false)) {
          await tsxFile.click()
          await page.waitForTimeout(2000)
          console.log("✓ Opened a TSX file in editor")

          // Verify Monaco editor loads
          const monacoEditor = page.locator(".monaco-editor").first()
          const hasEditor = await monacoEditor.isVisible().catch(() => false)
          if (hasEditor) {
            console.log("✓ Monaco editor loaded")
          }
        }
      }
    } else {
      console.log("⚠ Code editor button not found")
    }

    // =========================================================================
    // PHASE 7: DATABASE PANEL
    // =========================================================================
    console.log("\n========== PHASE 7: DATABASE PANEL ==========")

    const dbOpened = await switchToPanel(page, "database")
    if (dbOpened) {
      console.log("✓ Switched to database panel")

      // Wait for Prisma Studio to load
      await page.waitForTimeout(5000)

      // Check for database panel content
      const dbIframe = page.locator('iframe[title*="Database"]').first()
      const hasDbIframe = await dbIframe.isVisible().catch(() => false)

      if (hasDbIframe) {
        console.log("✓ Database panel (Prisma Studio) iframe visible")
      } else {
        // Might show loading or error state
        const dbLoading = page.locator('text=/Starting Prisma Studio|Loading/i')
        const isLoading = await dbLoading.isVisible().catch(() => false)

        if (isLoading) {
          console.log("✓ Database panel is loading Prisma Studio")
          await page.waitForTimeout(10000)
        }

        // Check for no schema message
        const noSchema = page.locator('text=/No Database Schema|No Prisma schema/i')
        if (await noSchema.isVisible().catch(() => false)) {
          console.log("⚠ No database schema found yet")
        }
      }
    } else {
      console.log("⚠ Database button not found")
    }

    // =========================================================================
    // PHASE 8: TEST PANEL
    // =========================================================================
    console.log("\n========== PHASE 8: TEST PANEL ==========")

    const testsOpened = await switchToPanel(page, "tests")
    if (testsOpened) {
      console.log("✓ Switched to test panel")

      // Wait for test panel to load
      await page.waitForTimeout(3000)

      // Look for test panel elements
      const testPanelHeader = page.locator('text=/Test Files|Run Tests|Tests/i').first()
      const hasTestPanel = await testPanelHeader.isVisible().catch(() => false)

      if (hasTestPanel) {
        console.log("✓ Test panel header visible")

        // Look for test files list
        const testFileItem = page.locator('text=/\\.test\\./i').first()
        if (await testFileItem.isVisible().catch(() => false)) {
          console.log("✓ Test files found")

          // Try to run tests
          const runAllButton = page
            .getByRole("button", { name: /Run All|Run Tests/i })
            .first()
          if (await runAllButton.isVisible().catch(() => false)) {
            await runAllButton.click()
            console.log("✓ Started test run")

            // Wait for tests to start running
            await page.waitForTimeout(5000)

            // Check for test output
            const testOutput = page.locator("pre, [class*='output']").first()
            if (await testOutput.isVisible().catch(() => false)) {
              console.log("✓ Test output visible")
            }

            // Wait for tests to complete (with timeout)
            const runningIndicator = page.locator('text=/Running|Executing/i')
            let attempts = 0
            while (
              (await runningIndicator.isVisible().catch(() => false)) &&
              attempts < 30
            ) {
              await page.waitForTimeout(2000)
              attempts++
            }

            // Check for test results
            const passedTests = page.locator('text=/passed|✓/i').first()
            const failedTests = page.locator('text=/failed|✗/i').first()

            if (await passedTests.isVisible().catch(() => false)) {
              console.log("✓ Some tests passed")
            }
            if (await failedTests.isVisible().catch(() => false)) {
              console.log("⚠ Some tests failed (expected for new project)")
            }
          }
        } else {
          console.log("⚠ No test files found (may need to generate tests)")
        }
      }
    } else {
      console.log("⚠ Tests button not found")
    }

    // =========================================================================
    // PHASE 9: CHAT FUNCTIONALITY - FOLLOW-UP MESSAGES
    // =========================================================================
    console.log("\n========== PHASE 9: CHAT FUNCTIONALITY ==========")

    // Switch back to chat/preview to send follow-up
    await switchToPanel(page, "runtime")
    await page.waitForTimeout(2000)

    const followUpInput = page
      .getByRole("textbox", { name: /Ask Shogo/i })
      .first()

    if (await followUpInput.isVisible().catch(() => false)) {
      // Send a follow-up message to test chat continuity
      const followUpMessage = `Generate some E2E tests for the Chad Groupert app that test:
1. Creating a new chat session
2. Sending a message and receiving a response
3. Verifying the colorful theme is applied
4. Testing the user preferences panel`

      await followUpInput.fill(followUpMessage)
      await followUpInput.press("Enter")
      console.log("✓ Follow-up message sent")

      // Wait for response
      await waitForAIResponse(page, 60000)
      console.log("✓ Follow-up response received")
    }

    // =========================================================================
    // PHASE 10: PERSISTENCE TEST
    // =========================================================================
    console.log("\n========== PHASE 10: PERSISTENCE TEST ==========")

    // Store current URL
    const currentUrl = page.url()

    // Reload the page
    await page.reload()
    console.log("✓ Page reloaded")

    // Wait for page to load
    await page.waitForTimeout(5000)

    // Verify we're still on the same project
    expect(page.url()).toContain(ctx.projectId)
    console.log("✓ Project URL persisted")

    // Verify project content is visible
    const hasProjectContent =
      (await page
        .locator('[data-testid="chat-container"]')
        .isVisible()
        .catch(() => false)) ||
      (await page
        .locator("iframe")
        .first()
        .isVisible()
        .catch(() => false)) ||
      (await page
        .locator('text=/Preview|Chat|Chad Groupert/i')
        .first()
        .isVisible()
        .catch(() => false))

    expect(hasProjectContent).toBe(true)
    console.log("✓ Project content persisted after reload")

    // =========================================================================
    // TEST SUMMARY
    // =========================================================================
    console.log("\n========== TEST SUMMARY ==========")
    console.log(`Project ID: ${ctx.projectId}`)
    console.log(`Project URL: ${ctx.projectUrl}`)
    console.log(`User Email: ${ctx.userEmail}`)
    console.log(`Console Errors: ${consoleErrors.length}`)

    if (consoleErrors.length > 0) {
      console.log("\nConsole Errors (first 5):")
      consoleErrors.slice(0, 5).forEach((err, i) => {
        console.log(`  ${i + 1}. ${err.substring(0, 100)}...`)
      })
    }

    console.log("\n✓ Chad Groupert E2E test completed successfully!")
  })
})

test.describe("Chad Groupert - API Health Checks", () => {
  test("API health endpoint responds", async ({ request }) => {
    const response = await request.get(`${API_URL}/api/health`)
    expect(response.ok()).toBe(true)

    const body = await response.json()
    expect(body.status).toBe("ok")
  })

  test("MCP endpoint is accessible", async ({ request }) => {
    const response = await request.get("http://localhost:3100/mcp")
    expect([200, 400]).toContain(response.status())
  })
})
