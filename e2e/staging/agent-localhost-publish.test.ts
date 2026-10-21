// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test, expect, type Page } from "./fixtures"
import { makeTestUser, waitForAgentResponse } from "./helpers"
import {
  INITIAL_BUILD_TIMEOUT_MS,
  LOCALHOST_RE,
  PREVIEW_URL_RE,
  agentMessageHrefs,
  agentMessageText,
  createProject,
  ensureAuthenticated,
  sendProjectChatMessage,
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

    const text = await agentMessageText(page)

    // The core guarantee: no localhost address anywhere the agent showed the
    // user. Judged on the agent's own messages — the echoed prompt, the
    // agent-logs pane and preview chrome are not the agent's words (SHO-128).
    expect(text, "agent must not hand out a localhost address").not.toMatch(LOCALHOST_RE)
    const localhostHrefs = (await agentMessageHrefs(page)).filter((href) =>
      LOCALHOST_RE.test(href),
    )
    expect(localhostHrefs, "the reply must not link to a localhost address").toEqual([])
    // And it should surface the real, reachable preview URL.
    expect(text, "agent should surface the public *.preview.*.shogo.ai URL").toMatch(
      PREVIEW_URL_RE,
    )
  })

  test("agent gives a Free user a working direct file download link", async ({ request }) => {
    test.setTimeout(360_000)

    // The file request is the project's very first prompt. A vague seed prompt
    // sends the agent off building a whole app (often >180s on staging) that
    // this test never uses, so ask for the artifact directly and skip the build.
    const prompt =
      "Create a small PDF named artifact-delivery-test.pdf in the workspace. " +
      "Then use the file-sharing tool to give me a direct download link. " +
      "Do not give me localhost, a preview URL, or a published app URL. " +
      "Do not build or scaffold an app."
    await createProject(page, prompt)
    await waitForAgentResponse(page, 240_000)

    // Only the agent's own reply — not the echoed prompt (which names the
    // guardrails) and not the agent-logs / preview chrome around it (SHO-128).
    const reply = await agentMessageText(page)
    expect(reply, "file delivery must not expose localhost").not.toMatch(LOCALHOST_RE)
    expect(reply, "file delivery must not use an app preview URL").not.toMatch(PREVIEW_URL_RE)
    const localhostHrefs = (await agentMessageHrefs(page)).filter((href) =>
      LOCALHOST_RE.test(href),
    )
    expect(localhostHrefs, "file delivery must not link to localhost").toEqual([])

    // A served file is a chip, never the raw URL as text (SHO-80): the transcript
    // shows the file name and the signed `/api/f/<token>` URL lives in the
    // anchor's href. Read the href — the body text has no URL to match.
    expect(reply, "file delivery must not print the raw signed URL").not.toMatch(/\/api\/f\//i)
    const chip = page.locator('a.chat-file-chip[href*="/api/f/"]').last()
    await expect(chip, "the reply should carry a served-file chip").toBeVisible({ timeout: 30_000 })
    expect(await chip.innerText(), "the chip should name the artifact").toContain(
      "artifact-delivery-test.pdf",
    )
    const link = await chip.getAttribute("href")
    expect(link, "agent should surface an expiring /f/ download URL").toBeTruthy()

    const response = await request.get(link!, { timeout: 60_000 })
    expect(response.status()).toBe(200)
    expect(response.headers()["content-disposition"]).toMatch(/^attachment;/i)
  })

  test("the hygiene checks read the agent's messages, not the page body", async () => {
    // Measured on the live transcript from the test above: `body.innerText`
    // carries the echoed prompt (which itself says "Do not give me localhost,
    // …") and the build-log / preview chrome, while `.chat-md` carries only the
    // agent's reply. That scope difference is the entire bug from run
    // 39574738520 — a correct reply failed on its own closing sentence — so
    // both halves are pinned here against a real page (SHO-128, AC3).
    const body = await page.locator("body").innerText()
    const agent = await agentMessageText(page)

    expect(body, "the page body carries the echoed prompt, which names localhost").toMatch(
      /Do not give me localhost/i,
    )
    expect(agent, "the agent's own messages must not include the echoed prompt").not.toMatch(
      /Do not give me localhost/i,
    )
    expect(agent, "the agent's own messages are the reply, not an empty scope").toMatch(
      /artifact-delivery-test\.pdf/,
    )
  })
})

/**
 * The scope every hygiene assertion has to read (SHO-128). `LOCALHOST_RE` and
 * `PREVIEW_URL_RE` are only meaningful against the agent's own words: the same
 * strings appear in the user's echoed prompt and in preview chrome, where they
 * are not a leak and must not fail the gate. Source-level, so a future
 * re-widening to `body.innerText` reds here instead of on a cold staging run
 * three merges later.
 */
test.describe("Agent preview hygiene scope", () => {
  const WHOLE_PAGE = /transcript\(\s*page\s*\)|locator\(\s*["']body["']\s*\)\s*\.innerText\(\)/
  // `expect(<value>, …).(not.)toMatch(LOCALHOST_RE|PREVIEW_URL_RE)`, across lines.
  const HYGIENE_ASSERTION =
    /expect\(\s*([A-Za-z_$][\w$]*)[\s\S]{0,200}?\.(?:not\.)?(?:toMatch|toContain)\(\s*(?:LOCALHOST_RE|PREVIEW_URL_RE)/g

  for (const file of ["agent-localhost-publish.test.ts", "agent-publish.test.ts"]) {
    test(`${file} never feeds a whole-page read to a hygiene matcher`, () => {
      const source = readFileSync(join(dirname(test.info().file), file), "utf8")
      for (const [, subject] of source.matchAll(HYGIENE_ASSERTION)) {
        // Where the asserted value came from: the `const` it was bound to.
        const binding = source.match(
          new RegExp(`(?:const|for \\(const)\\s+${subject}\\s*(?:=|of)\\s*([\\s\\S]{0,200}?)\\n`),
        )
        expect(binding, `${file}: "${subject}" is asserted but never bound`).toBeTruthy()
        expect(
          WHOLE_PAGE.test(binding![1]),
          `${file}: "${subject}" is a whole-page read (${binding![1].trim()}) — the ` +
            `hygiene matchers must read agentMessageText/agentMessageHrefs (SHO-128)`,
        ).toBe(false)
      }
    })
  }
})

/**
 * The matcher itself, on strings — no browser, no staging account. These are
 * the replies that made the staging gate red (SHO-128) and the leaks it has to
 * keep catching, pinned so a future loosening cannot quietly disarm the gate.
 */
test.describe("Agent preview hygiene matcher", () => {
  test("a reply that describes the guarantee is not a leak", () => {
    // The literal reply from run 39574738520 that failed on all three attempts.
    const reply =
      "Here is the download chip for artifact-delivery-test.pdf. No app was " +
      "built or scaffolded, and no localhost/preview/publish url is involved — " +
      "just the direct file download."
    expect(reply).not.toMatch(LOCALHOST_RE)
    expect(reply).not.toMatch(PREVIEW_URL_RE)
  })

  test("the prompt's own guardrails are not a leak", () => {
    const prompt =
      "Create a small PDF named artifact-delivery-test.pdf in the workspace. " +
      "Then use the file-sharing tool to give me a direct download link. " +
      "Do not give me localhost, a preview URL, or a published app URL. " +
      "Do not build or scaffold an app."
    expect(prompt).not.toMatch(LOCALHOST_RE)
    expect(prompt).not.toMatch(PREVIEW_URL_RE)
  })

  for (const leak of [
    "Your app is running at http://localhost:37675 — open it there.",
    "Open http://localhost to see the preview.",
    "https://localhost serves the app.",
    "The dev server is on 127.0.0.1:3000.",
    "It is listening on localhost:8080.",
    "Bound to 0.0.0.0:8080 as well.",
    "See [the running app](localhost:8080/preview).",
  ]) {
    test(`a reply that hands out a localhost address is a leak: ${leak}`, () => {
      expect(leak).toMatch(LOCALHOST_RE)
    })
  }

  test("a preview URL is a preview URL and nothing else", () => {
    const ok = "Open https://abc123.preview.staging.shogo.ai to see it."
    expect(ok).toMatch(PREVIEW_URL_RE)
    expect(ok).not.toMatch(LOCALHOST_RE)
  })
})
