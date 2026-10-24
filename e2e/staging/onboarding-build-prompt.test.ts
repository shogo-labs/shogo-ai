// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test } from "./fixtures"
import {
  APP_HOME_PATH,
  buildPromptInput,
  makeTestUser,
  onboardToBuildPrompt,
  signUp,
  waitForAgentIdle,
  waitForAgentResponse,
} from "./helpers"

/**
 * Team onboarding ends on "What do you want to build?". Submitting it opens a
 * fresh workspace-agent chat and sends the idea, wrapped with instructions to
 * research and plan before building. The chat shows only the idea. Skipping
 * lands on the team home.
 *
 *   E2E_TARGET_URL=http://localhost:8081 \
 *     npx playwright test --config e2e/playwright.config.ts onboarding-build-prompt
 */

const PLAN_INSTRUCTIONS = "research this and put a plan together"
const WORKSPACE_CHAT_POST = /\/api\/workspaces\/([^/]+)\/chat(\?|$)/

test.describe("Onboarding build prompt", () => {
  test("submitting the prompt opens a workspace agent chat that researches and plans", async ({ page }) => {
    await signUp(page, makeTestUser("OnboardingBuild"))
    expect(await onboardToBuildPrompt(page), "fresh account skipped onboarding").toBe(true)

    const input = buildPromptInput(page)
    await expect(input).toBeVisible()
    await expect(input).toHaveAttribute("placeholder", "Describe an agent, app, business idea, or workflow…")
    await expect(page.getByText("Start with an agent")).toHaveCount(0)

    // An empty prompt can't continue.
    await page.getByText("Start building", { exact: true }).click()
    await expect(page.getByText("What do you want to build?", { exact: true }).first()).toBeVisible()
    expect(page.url()).not.toMatch(/\/agent/)

    const idea = `A newsletter agent for indie bakeries ${Date.now()}`
    await input.fill(idea)

    const chatPost = page.waitForRequest(
      (req) => req.method() === "POST" && WORKSPACE_CHAT_POST.test(req.url()),
      { timeout: 90_000 },
    )
    await page.getByText("Start building", { exact: true }).click()

    await page.waitForURL(/\/agent\?.*chatSessionId=/, { timeout: 60_000 })
    const chatSessionId = new URL(page.url()).searchParams.get("chatSessionId")
    expect(chatSessionId, `no chatSessionId in ${page.url()}`).toBeTruthy()

    // The agent receives the idea plus the research-and-plan instructions.
    const request = await chatPost
    const workspaceId = request.url().match(WORKSPACE_CHAT_POST)![1]!
    const body = request.postData() ?? ""
    expect(body).toContain(idea)
    expect(body).toContain(PLAN_INSTRUCTIONS)
    expect(body).toContain("::Build Brief::")

    // The user message shows only the idea, not the marker or instructions.
    await expect(page.getByText(idea, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(new RegExp(PLAN_INSTRUCTIONS))).toHaveCount(0)
    await expect(page.getByText("::Build Brief::", { exact: false })).toHaveCount(0)

    await waitForAgentResponse(page)
    // The sidebar also shows the idea as the chat name, so compare counts across the reload.
    const ideaCount = await page.getByText(idea, { exact: true }).count()

    // Reloading the same URL (initialMessage still in it) must not send again.
    await page.reload()
    await waitForAgentIdle(page)
    await expect(page.getByText(idea, { exact: true }).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(idea, { exact: true })).toHaveCount(ideaCount)
    await expect(page.getByText(new RegExp(PLAN_INSTRUCTIONS))).toHaveCount(0)

    // The chat lives in the team workspace and is named from the raw idea, not the wrapper.
    const sessions = await page.evaluate(async (workspaceId) => {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
        credentials: "include",
      })
      if (!res.ok) throw new Error(`list sessions failed: ${res.status}`)
      const json = await res.json()
      return (json?.sessions ?? []) as Array<{ id: string; name?: string | null; inferredName?: string | null }>
    }, workspaceId)
    const session = sessions.find((s) => s.id === chatSessionId)
    expect(session, `session ${chatSessionId} not in workspace ${workspaceId}`).toBeTruthy()
    expect(`${session!.name ?? ""} ${session!.inferredName ?? ""}`).not.toContain("Before building anything")
  })

  test("skipping the prompt opens the workspace agent on an empty chat", async ({ page }) => {
    await signUp(page, makeTestUser("OnboardingSkip"))
    expect(await onboardToBuildPrompt(page), "fresh account skipped onboarding").toBe(true)

    await page.getByText("I'll explore first", { exact: true }).click()

    // SHO-4: a team cold start lands on the agent with a fresh session, not the
    // builder. The old home is one route away at /home.
    await expect(
      page.getByRole("textbox", { name: "Chat message input" }).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 60_000 })
    expect(new URL(page.url()).pathname).toBe("/")
    await expect(page.getByText("What are we building", { exact: false })).toHaveCount(0)

    await page.goto(APP_HOME_PATH)
    await page.waitForSelector("text=What are we building", { timeout: 30_000 })
    expect(new URL(page.url()).pathname).toBe(APP_HOME_PATH)
  })
})
