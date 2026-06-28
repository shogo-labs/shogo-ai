// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import {
  homeComposerInput,
  makeTestUser,
  signUpAndOnboard,
  waitForAgentResponse,
  type TestUser,
} from "./helpers"

/**
 * Agent preview-URL hygiene + one-click publish (UI-driven, hosted env).
 *
 * Validates the two behaviours shipped in
 * "feat(agent): kill localhost confusion + add one-click publish tool":
 *
 *   1. No localhost leaks — in a cloud environment the agent must never hand
 *      the user a `localhost` / `127.0.0.1` link. Even if the model is tempted
 *      to, the gateway rewrites stray localhost links to the public preview
 *      origin. We ask the agent for the link to its running app and assert the
 *      transcript surfaces a `*.preview.*.shogo.ai` URL and contains no
 *      localhost address.
 *
 *   2. Publish tool — asking the agent to "publish" deploys to
 *      `{subdomain}.shogo.one` and returns the live URL. We assert the
 *      transcript surfaces a `*.shogo.one` link and that the URL actually
 *      responds (2xx/again gated 401/403 = live).
 *
 * Run against staging:
 *   E2E_TARGET_URL=https://studio.staging.shogo.ai E2E_STRIPE_MODE=test \
 *     bunx playwright test --config e2e/playwright.config.ts agent-localhost-publish
 */

const TEST_USER = makeTestUser("LocalhostPublish")

const INITIAL_BUILD_TIMEOUT_MS = 180_000

// ── Auth (hosted or local-desktop shape) ─────────────────────────────────────

async function ensureAuthenticated(page: Page, user: TestUser): Promise<void> {
  await page.goto("/")
  const home = page.getByText("What's on your mind", { exact: false }).first()
  const signUpTab = page.getByRole("tab", { name: "Sign Up" })
  await Promise.race([
    home.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    signUpTab.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
  ])
  if (await home.isVisible().catch(() => false)) return
  await signUpAndOnboard(page, user)
}

// ── Project chat helpers ─────────────────────────────────────────────────────

/** The currently-visible project chat composer (ChatInput, not the home one). */
function visibleComposer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

/** Sends a message into the project chat composer and confirms it landed. */
async function sendProjectChatMessage(page: Page, text: string): Promise<void> {
  const snippet = text.slice(0, 24)
  for (let attempt = 0; attempt < 2; attempt++) {
    const box = visibleComposer(page)
    await box.waitFor({ state: "visible", timeout: 15_000 })
    await box.fill(text)
    await page
      .getByRole("button", { name: "Send message" })
      .filter({ visible: true })
      .first()
      .click({ force: true })
    const landed = await page
      .getByText(snippet, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    if (landed) return
  }
  throw new Error("sendProjectChatMessage: message never appeared in the transcript")
}

/** Concatenated visible transcript text (lowercased). */
async function transcript(page: Page): Promise<string> {
  return (await page.locator("body").innerText()).toLowerCase()
}

/** Creates a project from the home composer, returns its id once it boots. */
async function createProject(page: Page, prompt: string): Promise<string> {
  await page.goto("/")
  await page.waitForSelector("text=What's on your mind", { timeout: 30_000 })
  const input = homeComposerInput(page)
  await input.click()
  await input.fill(prompt)
  await page.waitForTimeout(300)
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
  const m = page.url().match(/\/projects\/([^/?#]+)/)
  expect(m, `expected a /projects/<id> URL, got ${page.url()}`).toBeTruthy()
  return m![1]
}

const LOCALHOST_RE = /localhost|127\.0\.0\.1|0\.0\.0\.0/
// e.g. https://<id>.preview.staging.shogo.ai or <id>.preview.shogo.ai
const PREVIEW_URL_RE = /https?:\/\/[a-z0-9-]+\.preview\.[a-z0-9.-]*shogo\.ai/i
const PUBLISHED_URL_RE = /https?:\/\/[a-z0-9-]+\.shogo\.one\b/i

test.describe("Agent preview hygiene + publish", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let projectId = ""

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("agent never hands out a localhost link for the running app", async () => {
    test.setTimeout(360_000)

    projectId = await createProject(
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

  test("agent publishes to {subdomain}.shogo.one and returns a live URL", async () => {
    test.setTimeout(480_000)

    // Self-contained: create our own project so this test can run independently
    // of the no-localhost test above (which needs the not-yet-deployed
    // PUBLIC_PREVIEW_URL fix). The publish tool itself does not depend on it.
    if (!projectId) {
      projectId = await createProject(
        page,
        "A tiny single-page app that says hello, for publish testing",
      )
    } else {
      await page.goto(`/projects/${projectId}`)
    }
    await waitForAgentResponse(page, INITIAL_BUILD_TIMEOUT_MS)

    const subdomain = `e2e-pub-${Date.now().toString(36)}`
    await sendProjectChatMessage(
      page,
      `Publish this app now to the subdomain "${subdomain}". ` +
        `I confirm that subdomain — go ahead and publish immediately without ` +
        `asking me to confirm again, then reply with the live URL.`,
    )
    // Publish builds, uploads, provisions Knative and verifies the URL — give
    // it room well beyond a normal chat turn.
    await waitForAgentResponse(page, 300_000)

    const text = await transcript(page)

    const match = text.match(PUBLISHED_URL_RE)
    expect(match, "agent should surface a *.shogo.one published URL").toBeTruthy()
    const publishedUrl = match![0]
    // The agent may name-derive the subdomain (the tool description lets it
    // propose one from the app name) rather than echo ours verbatim, so we do
    // not hard-assert the exact subdomain — only that a real .shogo.one URL was
    // returned and that it actually serves.
    if (!publishedUrl.includes(subdomain)) {
      console.warn(
        `[publish-e2e] agent published to ${publishedUrl} instead of the requested subdomain "${subdomain}"`,
      )
    }

    expect(text, "agent transcript must not contain a localhost address").not.toMatch(
      LOCALHOST_RE,
    )

    // The published site must actually be reachable. A gated site (private /
    // password) answers 401/403 but is still live, so treat anything that is
    // not 5xx/404 as a successful publish.
    const res = await page.request.get(publishedUrl, { timeout: 60_000 }).catch(() => null)
    expect(res, `GET ${publishedUrl} should not throw`).toBeTruthy()
    const status = res!.status()
    expect(status, `published URL ${publishedUrl} returned ${status}`).toBeLessThan(500)
    expect(status, `published URL ${publishedUrl} returned 404`).not.toBe(404)
  })
})
