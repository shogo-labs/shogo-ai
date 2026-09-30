// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import { makeTestUser, waitForAgentResponse } from "./helpers"
import {
  INITIAL_BUILD_TIMEOUT_MS,
  LOCALHOST_RE,
  PUBLISHED_URL_RE,
  createProject,
  ensureAuthenticated,
  sendProjectChatMessage,
  transcript,
} from "./agent-chat"

/**
 * Agent one-click publish (UI-driven, hosted env, Pro plan).
 *
 * Asking the agent to "publish" deploys to `{subdomain}.shogo.one` and returns
 * the live URL. Publishing to a subdomain is Pro+ (the API answers
 * `plan_not_allowed` on Free), so the account is upgraded before any test runs.
 *
 * Run against staging:
 *   E2E_TARGET_URL=https://studio.staging.shogo.ai E2E_STRIPE_MODE=test \
 *     bunx playwright test --config e2e/playwright.config.ts agent-publish
 */

const TEST_USER = makeTestUser("PublishPro")

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

test.describe("Agent publish (Pro)", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER, { pro: true })
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("agent publishes to {subdomain}.shogo.one and returns a live URL", async () => {
    test.setTimeout(480_000)

    await createProject(page, "A tiny single-page app that says hello, for publish testing")
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
