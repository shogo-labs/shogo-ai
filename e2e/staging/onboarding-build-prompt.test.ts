// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test } from "./fixtures"
import {
  AGENT_STOP_SELECTOR,
  APP_HOME_PATH,
  assertChatHealthy,
  buildPromptInput,
  extendTestTimeout,
  makeTestUser,
  onboardToBuildPrompt,
  signUp,
  waitForAgentIdle,
} from "./helpers"

/**
 * Team onboarding ends on "What do you want to build?". Submitting it opens a
 * fresh workspace-agent chat and sends the idea, wrapped with the build-first
 * brief (SHO-258: build now, share the preview, then state assumptions). The
 * chat shows only the idea. Skipping lands on the team home.
 *
 *   E2E_TARGET_URL=http://localhost:8081 \
 *     npx playwright test --config e2e/playwright.config.ts onboarding-build-prompt
 */

const BUILD_INSTRUCTIONS = "Build a first working version of this in this turn"
const WORKSPACE_CHAT_POST = /\/api\/workspaces\/([^/]+)\/chat(\?|$)/

test.describe("Onboarding build prompt", () => {
  test("submitting the prompt opens a workspace agent chat that builds first", async ({ page }) => {
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

    // The agent receives the idea plus the build-first instructions.
    const request = await chatPost
    const workspaceId = request.url().match(WORKSPACE_CHAT_POST)![1]!
    const body = request.postData() ?? ""
    expect(body).toContain(idea)
    expect(body).toContain(BUILD_INSTRUCTIONS)
    expect(body).toContain("::Build Brief::")
    // SHO-258 replaced the research-and-plan brief; it must not come back.
    expect(body).not.toContain("put a plan together")

    // The user message shows only the idea, not the marker or instructions.
    await expect(page.getByText(idea, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(new RegExp(BUILD_INSTRUCTIONS))).toHaveCount(0)
    await expect(page.getByText("::Build Brief::", { exact: false })).toHaveCount(0)

    // Build-first onboarding means the agent actually builds now, which streams
    // for minutes; waiting for the whole turn made a critical-path test
    // time-dependent (it timed out at 240s against staging). What this test
    // protects is that the brief reached the workspace chat and the turn
    // started — the build itself is covered by the preview suites.
    // The chat POST is an SSE stream, so its response object can lag the request
    // by a beat; reading it opportunistically would turn this critical-path test
    // red on a slow api for no product reason. Take it if it is already there,
    // otherwise wait for it.
    const chatResponse =
      (await request.response()) ??
      (await page.waitForResponse((res) => res.request() === request, { timeout: 30_000 }))
    expect(chatResponse.ok(), `workspace chat POST failed: ${chatResponse.status()}`).toBe(true)
    // The default test budget is 120s and the waits below can add 80s on top of
    // an already-slow cold runtime.
    extendTestTimeout(60_000)
    await page.waitForSelector(AGENT_STOP_SELECTOR, { state: "attached", timeout: 60_000 })
    await assertChatHealthy(page)

    // The sidebar also shows the idea as the chat name, so compare counts across the reload.
    const ideaCount = await page.getByText(idea, { exact: true }).count()

    // Reloading the same URL (initialMessage still in it) must not send again.
    await page.reload()
    // Best effort: the turn may still be streaming (the build can outlast the
    // test), and the assertions below only need the message, not the turn end.
    await waitForAgentIdle(page, 20_000)
    await expect(page.getByText(idea, { exact: true }).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(idea, { exact: true })).toHaveCount(ideaCount)
    await expect(page.getByText(new RegExp(BUILD_INSTRUCTIONS))).toHaveCount(0)

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
    expect(`${session!.name ?? ""} ${session!.inferredName ?? ""}`).not.toContain(BUILD_INSTRUCTIONS)
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
