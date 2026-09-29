// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import { makeTestUser, waitForAgentResponse } from "./helpers"
import {
  INITIAL_BUILD_TIMEOUT_MS,
  LOCALHOST_RE,
  PREVIEW_URL_RE,
  createProject,
  ensureAuthenticated,
  sendProjectChatMessage,
  transcript,
} from "./agent-chat"

/**
 * Agent preview-URL hygiene (UI-driven, hosted env, Free plan).
 *
 * Validates the behaviour shipped in
 * "feat(agent): kill localhost confusion + add one-click publish tool":
 * in a cloud environment the agent must never hand the user a `localhost` /
 * `127.0.0.1` link. Even if the model is tempted to, the gateway rewrites
 * stray localhost links to the public preview origin. We ask the agent for the
 * link to its running app and assert the transcript surfaces a
 * `*.preview.*.shogo.ai` URL and contains no localhost address. A Free user
 * also gets a direct file download link rather than a preview/published URL.
 *
 * Publishing to `{subdomain}.shogo.one` is Pro+ and lives in
 * agent-publish.test.ts, outside the critical path.
 *
 * Run against staging:
 *   E2E_TARGET_URL=https://studio.staging.shogo.ai E2E_STRIPE_MODE=test \
 *     bunx playwright test --config e2e/playwright.config.ts agent-localhost-publish
 */

const TEST_USER = makeTestUser("PreviewPub")

test.describe("Agent preview hygiene", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("agent never hands out a localhost link for the running app", async () => {
    test.setTimeout(360_000)

    await createProject(
      page,
      "A tiny single-page app that says hello, for preview-URL testing",
    )

    // Let the initial build settle so a running preview actually exists.
    await waitForAgentResponse(page, INITIAL_BUILD_TIMEOUT_MS)

    await sendProjectChatMessage(
      page,
      "What is the public URL where I can open my running app right now? " +
        "Reply with the exact link I should click.",
    )
    await waitForAgentResponse(page, 120_000)

    const text = await transcript(page)

    // The core guarantee: no localhost address anywhere the user can see it.
    expect(text, "agent transcript must not contain a localhost address").not.toMatch(
      LOCALHOST_RE,
    )
    // And it should surface the real, reachable preview URL.
    expect(text, "agent should surface the public *.preview.*.shogo.ai URL").toMatch(
      PREVIEW_URL_RE,
    )
  })

  test("agent gives a Free user a working direct file download link", async ({ request }) => {
    test.setTimeout(360_000)

    await createProject(page, "A project for testing direct artifact delivery")
    await waitForAgentResponse(page, INITIAL_BUILD_TIMEOUT_MS)
    const prompt =
      "Create a small PDF named artifact-delivery-test.pdf in the workspace. " +
      "Then use the file-sharing tool to give me a direct download link. " +
      "Do not give me localhost, a preview URL, or a published app URL."
    await sendProjectChatMessage(page, prompt)
    await waitForAgentResponse(page, 180_000)

    // Only judge the reply to this prompt: the initial build turn legitimately
    // surfaces the preview URL and may share files of its own. Read the raw
    // text because `transcript()` lowercases, which breaks the signed /f/ token.
    const rawText = await page.locator("body").innerText()
    const promptAt = rawText.lastIndexOf(prompt.slice(0, 40))
    expect(promptAt, "follow-up prompt should be in the transcript").toBeGreaterThanOrEqual(0)
    const reply = rawText.slice(promptAt)
    expect(reply.toLowerCase(), "file delivery must not expose localhost").not.toMatch(LOCALHOST_RE)
    expect(reply, "file delivery must not use an app preview URL").not.toMatch(PREVIEW_URL_RE)
    const link = reply.match(/https?:\/\/[^\s<>()]+\/f\/[A-Za-z0-9._-]+/i)
    expect(link, "agent should surface an expiring /f/ download URL").toBeTruthy()

    const response = await request.get(link![0], { timeout: 60_000 })
    expect(response.status()).toBe(200)
    expect(response.headers()["content-disposition"]).toMatch(/^attachment;/i)
  })
})
