// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import {
  makeTestUser,
  signUpAndOnboard,
  createProjectAndWait,
  NO_BUILD_PROJECT_PROMPT,
  sendChatMessage,
  waitForAgentResponse,
} from "./helpers"

/**
 * Plans E2E Tests
 *
 * There is one chat mode, so a plan is something the agent produces when the
 * request asks for one — never a separate "Plan mode" the composer selects.
 * This spec covers the whole plan lifecycle from a plain agent turn:
 *
 *   1. Asking for a plan first produces a plan card
 *   2. The plan card opens the saved plan artifact in the Plans panel
 *   3. Build executes the plan in the same chat
 *
 * Run: STAGING_URL=https://your-staging-host npx playwright test --config e2e/playwright.config.ts plans
 */

const TEST_USER = makeTestUser("Plans")

test.describe("Plans", () => {
  test.describe.configure({ mode: "serial" })
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("create a project for plan testing", async () => {
    await createProjectAndWait(page, NO_BUILD_PROJECT_PROMPT)
    expect(page.url()).toMatch(/\/projects\//)
  })

  test("asking for a plan first produces a plan card", async () => {
    // Let the auto-hello stream finish before sending.
    await page.waitForTimeout(3000)
    await waitForAgentResponse(page)

    await sendChatMessage(
      page,
      "Make a plan first, don't build yet: add a hello.txt file in the workspace root that contains 'Hello World'. Do not ask clarifying questions — create the plan now using the create_plan tool."
    )
    await waitForAgentResponse(page, 180_000)

    // A plan card should appear with the plan-file and Build actions
    await expect(page.getByRole("button", { name: "Build plan" })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: "View plan in Plans" })).toBeVisible({
      timeout: 30_000,
    })
  })

  test("plan card opens saved plan artifact", async () => {
    await page.getByRole("button", { name: "View plan in Plans" }).click()
    await expect(page.getByText("Plans")).toBeVisible({ timeout: 10_000 })
    // The Plans viewer adds its own Build button next to the chat dock's.
    await expect(page.getByRole("button", { name: "Build plan" })).toHaveCount(2, { timeout: 15_000 })
    await expect(page.getByText(/hello\.txt|Hello World/i).first()).toBeVisible({ timeout: 15_000 })
  })

  test("Build executes the plan in the same chat", async () => {
    await page.getByRole("button", { name: "Build plan" }).first().click()

    await expect(page.getByText("Execute the confirmed plan.")).toBeVisible({ timeout: 10_000 })
    await waitForAgentResponse(page, 180_000)

    await expect(page.locator("body")).toContainText(/hello\.txt|Hello World|created|added/i, { timeout: 30_000 })
  })

  test("Plans panel lists the saved plan", async () => {
    // The top bar's Plans tab carries `project-tab-plans`. `getByLabel("Plans")`
    // is ambiguous: the account menu's own label, the tab, and the viewer's
    // "Back to plans" button all match it.
    await page.getByTestId("project-tab-plans").click({ timeout: 10_000 })
    await page.waitForTimeout(2000)

    const planContent = page.getByText(/Hello World File|hello/i)
    await expect(planContent.first()).toBeVisible({ timeout: 15_000 })
  })
})
