// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import {
  AGENT_STOP_SELECTOR,
  assertChatHealthy,
  createProjectAndWait,
  makeTestUser,
  projectComposerInput,
  sendChatMessage,
  signUpAndOnboard,
  waitForAgentResponse,
  type TestUser,
} from "./helpers"
import { throttleCpu } from "../shared/live-turn-replay"

/**
 * A real agent turn longer than 90 seconds, then a reopen while it still runs.
 *
 * Guards the 2026-10-07 incident: the API's metal chat fetch budget (90s) also
 * aborted the response body, so every turn longer than that was cut while the
 * agent kept running. The client's auto-resume hid the cut on a good network,
 * then reattached by replaying the whole turn, which crashed or froze the chat
 * panel on phones. No staging test ran a turn that long, and none reopened a
 * project while its turn was still running.
 *
 *   1. Ask the agent to run a ~2.5 minute shell command, then echo a marker the
 *      prompt doesn't contain (the shell computes part of it).
 *   2. Keep the turn's stream open past the 90s mark: the client must not have
 *      to reconnect (`[AutoResume] … EOF without turn-complete`), which is how
 *      a server-side cut shows up.
 *   3. Reload the project with the CPU throttled to phone speed while the
 *      command still runs: the panel has to reattach to the live turn.
 *   4. The turn must finish (stop button gone, no error banner, no panel
 *      crash) and show the marker; after another reload the marker must still
 *      be there (the full turn was persisted, not a cut-off prefix).
 *
 * Run: E2E_TARGET_URL=... npx playwright test --config e2e/playwright.config.ts chat-long-turn
 */

const TEST_USER = makeTestUser("LongTurn")
const RUN = Date.now().toString(36)
const MARKER = `LONG_TURN_42_${RUN}`
const SLEEP_SECONDS = 150
// Past the API's old 90s cut, with margin for the agent to start the command.
const UNINTERRUPTED_MS = 105_000
const CPU_THROTTLE = 4

async function ensureAuthenticated(page: Page, user: TestUser): Promise<void> {
  await page.goto("/")
  const home = page.getByText("What are we building", { exact: false }).first()
  const signUpTab = page.getByRole("tab", { name: "Sign Up" })
  await Promise.race([
    home.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    signUpTab.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
  ])
  if (await home.isVisible().catch(() => false)) return
  await signUpAndOnboard(page, user)
}

test.describe("Long chat turn", () => {
  test("a turn longer than 90s survives a reopen mid-turn", async ({ page }) => {
    test.setTimeout(600_000)
    await ensureAuthenticated(page, TEST_USER)
    await createProjectAndWait(
      page,
      "Create the simplest possible starter app: a single page that shows the word Hello. Do not add any extra pages, components, features, or backend.",
    )
    // The home composer hands off a workspace-scoped chat, which is proxied by a
    // different route; the cut lived in the project chat route, so the long turn
    // runs in an ordinary project chat.
    const projectId = new URL(page.url()).pathname.match(/\/projects\/([^/?#]+)/)?.[1]
    expect(projectId, `not on a project page: ${page.url()}`).toBeTruthy()
    const sessionId = await page.evaluate(async (projectId) => {
      const res = await fetch("/api/chat-sessions", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inferredName: "Long turn E2E", contextType: "project", contextId: projectId }),
      })
      if (!res.ok) throw new Error(`chat session create failed: ${res.status}`)
      const json = await res.json()
      return (json?.data?.id ?? json?.id) as string
    }, projectId!)
    expect(sessionId, "chat session create returned no id").toBeTruthy()
    const projectUrl = `/projects/${projectId}?chatSessionId=${sessionId}`
    await page.goto(projectUrl)
    await projectComposerInput(page).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 60_000 })

    const chatPost = page.waitForRequest(
      (req) => req.method() === "POST" && /\/api\/(projects|workspaces)\/[^/]+\/chat(\?|$)/.test(req.url()),
      { timeout: 60_000 },
    )
    await sendChatMessage(
      page,
      `Use the exec tool to run exactly this command and wait for it to finish — it takes about ` +
        `${SLEEP_SECONDS} seconds; if exec returns a run_id, keep calling exec_wait until it completes: ` +
        `sleep ${SLEEP_SECONDS} && echo LONG_TURN_$((6*7))_${RUN}\n` +
        `Then reply with only the line the command printed. Do not change any files.`,
    )
    expect((await chatPost).url(), "the long turn did not go through the project chat route").toMatch(
      new RegExp(`/api/projects/${projectId}/chat(\\?|$)`),
    )
    await page.waitForSelector(AGENT_STOP_SELECTOR, { state: "attached", timeout: 60_000 })

    const reconnects: string[] = []
    const onConsole = (msg: { text(): string }) => {
      const text = msg.text()
      if (/\[AutoResume[^\]]*\].*(EOF without turn-complete|reconnecting fromSeq)/.test(text)) reconnects.push(text.slice(0, 300))
    }
    page.on("console", onConsole)
    await page.waitForTimeout(UNINTERRUPTED_MS)
    page.off("console", onConsole)
    expect(reconnects, "the turn's stream was cut before the turn finished").toEqual([])
    await expect(page.locator(AGENT_STOP_SELECTOR).first(), "the turn ended before the command finished").toBeAttached()

    // The user comes back to the project while the agent is still working.
    await throttleCpu(page, CPU_THROTTLE)
    await page.goto(projectUrl)

    await waitForAgentResponse(page, 300_000)
    await expect(page.getByText(MARKER).first()).toBeVisible({ timeout: 30_000 })

    await throttleCpu(page, 1)
    await page.reload()
    await expect(page.getByText(MARKER).first()).toBeVisible({ timeout: 60_000 })
    await assertChatHealthy(page)
  })
})
