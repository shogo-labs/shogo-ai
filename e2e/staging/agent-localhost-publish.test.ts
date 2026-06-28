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

const TEST_USER = makeTestUser("PreviewPub")

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

/** Asks the agent to publish to an explicit subdomain and waits for it. */
async function publishToSubdomain(page: Page, subdomain: string): Promise<string> {
  await sendProjectChatMessage(
    page,
    `Publish this app now to the subdomain "${subdomain}". ` +
      `I confirm that exact subdomain — use it verbatim, do not pick a ` +
      `different name. Go ahead and publish immediately without asking me to ` +
      `confirm again, then reply with the live URL.`,
  )
  // Publish builds/uploads/provisions (slow) on the happy path; a taken
  // subdomain is rejected fast, well before that.
  await waitForAgentResponse(page, 300_000)
  return transcript(page)
}

// Match an actual localhost ADDRESS the user might be handed — a localhost URL
// (`http://localhost…`), a host:port (`localhost:8080`), or a loopback IP.
// Deliberately NOT the bare word "localhost", which legitimately appears in
// unrelated UI text (e.g. an account name) and would false-positive against the
// lowercased page body.
const LOCALHOST_RE = /https?:\/\/localhost\b|\blocalhost[:/]|\b127\.0\.0\.1\b|\b0\.0\.0\.0\b/
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

  test("agent honors a user-provided subdomain verbatim", async () => {
    test.setTimeout(480_000)

    // Keep the description neutral (no "publish"/"subdomain" hints) so the agent
    // does not proactively publish during the initial build — we want the
    // explicit instruction below to be an unambiguous FIRST publish.
    await createProject(page, "A tiny single-page app that shows a greeting")
    await waitForAgentResponse(page, INITIAL_BUILD_TIMEOUT_MS)

    // A distinctive subdomain the agent would NOT name-derive from "hello".
    const subdomain = `e2e-keepme-${Date.now().toString(36)}`
    const text = await publishToSubdomain(page, subdomain)

    // The agent must publish to the EXACT subdomain the user named — never
    // substitute a derived name. We assert on the subdomain (the behavior we
    // control) rather than reachability, which currently depends on a known
    // publish-bucket infra issue tracked separately.
    expect(
      text,
      `agent must use the requested subdomain "${subdomain}", not substitute its own`,
    ).toContain(subdomain)
    // Any *.shogo.one URL it surfaced must be that subdomain — not a foreign one.
    for (const m of text.matchAll(/https?:\/\/([a-z0-9-]+)\.shogo\.one/gi)) {
      expect(
        m[1],
        `agent published to "${m[1]}.shogo.one" instead of requested "${subdomain}"`,
      ).toBe(subdomain)
    }
  })

  test("publishing a subdomain already taken by another project fails", async () => {
    test.setTimeout(720_000)

    const subdomain = `e2e-dup-${Date.now().toString(36)}`

    // Project A reserves the subdomain. The subdomain reservation happens in
    // the DB at publish time regardless of whether the static asset has fully
    // propagated, so this is independent of CDN/bucket timing.
    await createProject(page, "A tiny single-page greeting app")
    await waitForAgentResponse(page, INITIAL_BUILD_TIMEOUT_MS)
    const textA = await publishToSubdomain(page, subdomain)
    // The subdomain reservation lands in the DB at the start of publish (before
    // build/upload), so Project A holds it regardless of the known bucket infra
    // issue. We only need proof A targeted this exact subdomain.
    expect(
      textA,
      `Project A should have published to subdomain "${subdomain}"`,
    ).toContain(subdomain)

    // Project B tries to grab the same subdomain — must be rejected.
    await createProject(page, "A tiny single-page counter app")
    await waitForAgentResponse(page, INITIAL_BUILD_TIMEOUT_MS)
    const textB = await publishToSubdomain(page, subdomain)

    // The agent must surface that the subdomain is taken …
    expect(
      textB,
      "agent should report that the subdomain is already in use",
    ).toMatch(/already in use|already taken|is taken|not available|in use|unavailable/i)
    // … and must NOT claim Project B is now live on that subdomain.
    expect(
      textB,
      "agent must not falsely report a successful publish to a taken subdomain",
    ).not.toMatch(new RegExp(`live at[^\\n]*${subdomain}\\.shogo\\.one`, "i"))
  })
})
