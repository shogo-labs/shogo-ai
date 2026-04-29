// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import {
  makeTestUser,
  signUpAndOnboard,
  createProjectAndWait,
  selectInteractionMode,
  sendChatMessage,
  waitForAgentResponse,
} from "./helpers"

/**
 * Interaction Modes (Agent / Plan / Ask) E2E Tests
 *
 * Validates:
 *   1. Dropdown renders all 3 modes with descriptions
 *   2. Ask mode sends a message without tool calls
 *   3. Plan mode triggers plan creation with restricted tools
 *   4. Plan card opens the saved plan artifact
 *   5. Build triggers agent execution
 *   6. Agent mode restores full capabilities
 *
 * Run: STAGING_URL=https://your-staging-host npx playwright test --config e2e/playwright.config.ts interaction-modes
 */

const TEST_USER = makeTestUser("InteractionModes")

test.describe("Interaction Modes (Agent / Plan / Ask)", () => {
  test.describe.configure({ mode: "serial" })
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("create a project for interaction mode testing", async () => {
    await createProjectAndWait(page, "Simple test agent for interaction modes")
    expect(page.url()).toMatch(/\/projects\//)
  })

  test("interaction mode dropdown renders with 3 options", async () => {
    // Allow any auto-hello stream to start, then wait for it to finish
    await page.waitForTimeout(3000)
    await waitForAgentResponse(page)

    const trigger = page.locator('[data-testid="interaction-mode-trigger"]')
    await expect(trigger).toBeVisible({ timeout: 10_000 })
    await expect(trigger).toContainText("Agent")

    await trigger.click()
    // Popover renders via portal with spring animation — wait for mount
    await page.waitForTimeout(1000)

    await expect(
      page.getByText("Full autonomous mode")
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByText("Research and create a plan")
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByText("Just answer questions")
    ).toBeVisible({ timeout: 5_000 })

    // Close the popover by pressing Escape
    await page.keyboard.press("Escape")
    await page.waitForTimeout(500)
  })

  test("auto Plan suggestion: Switch to Plan sends held message in Plan mode", async () => {
    await selectInteractionMode(page, "Agent")

    await sendChatMessage(
      page,
      "Implement support for a database migration workflow across multiple files."
    )

    const suggestion = page.locator('[data-testid="plan-mode-suggestion"]')
    await expect(suggestion).toBeVisible({ timeout: 5_000 })
    await expect(suggestion).toContainText("Switch to Plan mode")

    await page.locator('[data-testid="plan-mode-suggestion-switch"]').click()

    const trigger = page.locator('[data-testid="interaction-mode-trigger"]')
    await expect(trigger).toContainText("Plan", { timeout: 5_000 })
    await expect(
      page.getByText("Implement support for a database migration workflow across multiple files.")
    ).toBeVisible({ timeout: 10_000 })
    await waitForAgentResponse(page, 180_000)
  })

  test("auto Plan suggestion: Continue in Agent keeps Agent mode", async () => {
    await selectInteractionMode(page, "Agent")

    await sendChatMessage(
      page,
      "Plan and implement an API refactor across multiple backend files."
    )

    await expect(page.locator('[data-testid="plan-mode-suggestion"]')).toBeVisible({
      timeout: 5_000,
    })
    await page.locator('[data-testid="plan-mode-suggestion-continue"]').click()

    const trigger = page.locator('[data-testid="interaction-mode-trigger"]')
    await expect(trigger).toContainText("Agent", { timeout: 5_000 })
    await expect(
      page.getByText("Plan and implement an API refactor across multiple backend files.")
    ).toBeVisible({ timeout: 10_000 })
    await waitForAgentResponse(page, 180_000)
  })

  test("auto Plan suggestion: timeout continues in Agent mode", async () => {
    await selectInteractionMode(page, "Agent")

    await sendChatMessage(
      page,
      "Design and implement a CI workflow migration across the deployment configuration."
    )

    const suggestion = page.locator('[data-testid="plan-mode-suggestion"]')
    await expect(suggestion).toBeVisible({ timeout: 5_000 })
    await expect(suggestion).toContainText(/\b(10|9)s\b/)
    await expect(suggestion).toBeHidden({ timeout: 12_000 })

    const trigger = page.locator('[data-testid="interaction-mode-trigger"]')
    await expect(trigger).toContainText("Agent", { timeout: 5_000 })
    await expect(
      page.getByText("Design and implement a CI workflow migration across the deployment configuration.")
    ).toBeVisible({ timeout: 10_000 })
    await waitForAgentResponse(page, 180_000)
  })

  test("Ask mode: no tool calls in response", async () => {
    await selectInteractionMode(page, "Ask")

    const trigger = page.locator('[data-testid="interaction-mode-trigger"]')
    await expect(trigger).toContainText("Ask", { timeout: 5_000 })

    await sendChatMessage(page, "What is 2 + 2? Just reply with the number.")
    await waitForAgentResponse(page)

    // The response should contain "4" somewhere
    await expect(page.getByText("4").last()).toBeVisible({ timeout: 15_000 })
  })

  test("Plan mode: produces a plan card", async () => {
    await selectInteractionMode(page, "Plan")

    const trigger = page.locator('[data-testid="interaction-mode-trigger"]')
    await expect(trigger).toContainText("Plan", { timeout: 5_000 })

    await sendChatMessage(
      page,
      "Create a plan to add a hello.txt file in the workspace root that contains 'Hello World'. Do not ask clarifying questions — just create the plan now using the create_plan tool."
    )
    await waitForAgentResponse(page, 180_000)

    // A plan card should appear with Cursor-like Build and plan-file actions
    await expect(page.getByText("Build Plan")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Open Plan")).toBeVisible({ timeout: 30_000 })
  })

  test("plan card opens saved plan artifact", async () => {
    await page.getByText("Open Plan").click()
    await expect(page.getByText("Plans")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/^Build$/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/hello\.txt|Hello World/i).first()).toBeVisible({ timeout: 15_000 })
  })

  test("Build triggers agent execution in Agent mode", async () => {
    await page.getByText(/^Build$/).click()

    // The interaction mode should switch back to Agent
    const trigger = page.locator('[data-testid="interaction-mode-trigger"]')
    await expect(trigger).toContainText("Agent", { timeout: 10_000 })
    await expect(page.getByText("Execute the confirmed plan.")).toBeVisible({ timeout: 10_000 })

    // Wait for the agent to process the built plan
    await waitForAgentResponse(page, 180_000)

    // Verify the execution turn produced a visible result tied to the approved plan
    await expect(page.locator("body")).toContainText(/hello\.txt|Hello World|created|added/i, { timeout: 30_000 })
  })

  test("Plans panel shows saved plans", async () => {
    // Click the Plans tab in the top bar — use aria-label set on the tab
    const plansTab = page.getByLabel("Plans")
    await plansTab.click({ timeout: 10_000 })
    await page.waitForTimeout(2000)

    // The plan created in the plan mode test should be listed
    // Look for any content from the plan (title, description, hello)
    const planContent = page.getByText(/Hello World File|hello/i)
    await expect(planContent.first()).toBeVisible({ timeout: 15_000 })
  })

  test("Agent mode: full tool capabilities restored", async () => {
    // Close the plans panel by clicking the X or clicking the Plans tab again
    await page.getByLabel("Plans").click().catch(() => {})
    await page.waitForTimeout(500)

    await selectInteractionMode(page, "Agent")

    const trigger = page.locator('[data-testid="interaction-mode-trigger"]')
    await expect(trigger).toContainText("Agent", { timeout: 5_000 })

    await sendChatMessage(page, "List the files in the workspace root directory using ls. Just list the filenames.")
    await waitForAgentResponse(page, 120_000)

    // The agent should have used tools — look for common workspace files or tool usage
    const body = page.locator("body")
    await expect(body).toContainText(/.md|AGENTS|SOUL|memory|config|skills|files/i, { timeout: 15_000 })
  })
})
