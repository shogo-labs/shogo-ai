// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import { makeTestUser, MINIMAL_APP_PROMPT, waitForAgentResponse } from "./helpers"
import {
  INITIAL_BUILD_TIMEOUT_MS,
  LOCALHOST_RE,
  PUBLISHED_URL_RE,
  agentMessageText,
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

/**
 * Every project this suite creates, so `afterAll` can delete them through the
 * normal API. Without this the suite leaked a staging project — and a live
 * `published-*` runtime — on every run (SHO-138: 10 of staging's 14 published
 * services were this suite's leftovers).
 */
const createdProjects: Array<{ id: string; subdomain?: string }> = []

/** Create a project, wait for its first build, and register it for cleanup. */
async function createTrackedProject(page: Page): Promise<{ id: string; subdomain?: string }> {
  const id = await createProject(page, MINIMAL_APP_PROMPT)
  const entry: { id: string; subdomain?: string } = { id }
  createdProjects.push(entry)
  await waitForAgentResponse(page, INITIAL_BUILD_TIMEOUT_MS)
  return entry
}

/**
 * Poll a published URL until it stops serving (404/410). Deleting a project has
 * to take its site down, so this is both the cleanup check and the e2e for
 * SHO-138.
 */
async function waitForSubdomainGone(
  page: Page,
  subdomain: string,
  timeoutMs = 90_000,
): Promise<number | null> {
  const url = `https://${subdomain}.shogo.one/`
  const deadline = Date.now() + timeoutMs
  let last: number | null = null
  while (Date.now() < deadline) {
    const res = await page.request
      .get(url, { timeout: 20_000, failOnStatusCode: false })
      .catch(() => null)
    last = res ? res.status() : null
    if (last === 404 || last === 410) return last
    await new Promise((r) => setTimeout(r, 5_000))
  }
  return last
}

/**
 * Does the published site actually serve right now?
 *
 * The delete→404 assertion below is only meaningful if the site was serving
 * BEFORE the delete. On an environment whose published bucket does not feed the
 * edge (staging has this today: every published project answers 404), a bare
 * "is it 404 after deleting" check passes without proving anything — QA caught
 * exactly that on round 1. So probe first, and skip with a reason when the
 * environment cannot serve.
 */
async function probeServing(
  page: Page,
  subdomain: string,
): Promise<{ serving: boolean; status: number | null }> {
  const res = await page.request
    .get(`https://${subdomain}.shogo.one/`, {
      timeout: 20_000,
      failOnStatusCode: false,
    })
    .catch(() => null)
  const status = res ? res.status() : null
  return {
    // A gated site answers 401/403 and is still live; 404/410 means the edge
    // has nothing for this host, and 5xx means it is broken, not published.
    serving: status !== null && status < 500 && status !== 404 && status !== 410,
    status,
  }
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
    test.setTimeout(300_000)
    const failures: string[] = []
    const origin = new URL(page.url()).origin

    // Probe BEFORE deleting: a site that already answers 404 cannot prove the
    // delete took it down, so that check is reported as skipped, not passed.
    const wasServing = new Map<string, { serving: boolean; status: number | null }>()
    for (const project of createdProjects) {
      if (!project.subdomain) continue
      wasServing.set(project.subdomain, await probeServing(page, project.subdomain))
    }

    // Delete through the normal API: the project-delete hook is exactly what
    // SHO-138 fixed, and this doubles as the e2e for it.
    const published: string[] = []
    for (const project of createdProjects) {
      const res = await page.request
        .delete(`${origin}/api/projects/${project.id}`, { timeout: 60_000 })
        .catch(() => null)
      if (!res || !res.ok()) {
        failures.push(
          `${project.id}: delete returned ${res ? res.status() : "no response"}`,
        )
        continue
      }
      if (project.subdomain) published.push(project.subdomain)
    }

    // Poll the published sites together — one site per published test, so
    // serial polling would multiply the timeout by the number of tests.
    const gone = await Promise.all(
      published.map(async (subdomain) => ({
        subdomain,
        status: await waitForSubdomainGone(page, subdomain),
      })),
    )
    for (const { subdomain, status } of gone) {
      const before = wasServing.get(subdomain)
      if (!before?.serving) {
        console.warn(
          `[publish-e2e] SKIPPED the delete-takes-the-site-down check for ` +
            `${subdomain}.shogo.one: it answered ${before?.status ?? "nothing"} ` +
            `BEFORE the delete, so a 404 now proves nothing. This environment ` +
            `does not serve published sites (staging bucket/edge mismatch) — the ` +
            `check only means something where a publish actually goes live.`,
        )
        continue
      }
      if (status !== 404 && status !== 410) {
        failures.push(
          `${subdomain}.shogo.one served ${before.status} before its project was ` +
            `deleted and still served ${status} after`,
        )
      }
    }

    await page.close()
    expect(failures, `published-site cleanup failed: ${failures.join("; ")}`).toEqual([])
  })

  test("agent publishes to {subdomain}.shogo.one and returns a live URL", async () => {
    test.setTimeout(480_000)

    const project = await createTrackedProject(page)

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

    // The agent's own messages: the published URL has to come from the reply,
    // and the localhost check must not read preview chrome or the echoed
    // prompt (SHO-128).
    const text = await agentMessageText(page)

    const match = text.match(PUBLISHED_URL_RE)
    expect(match, "agent should surface a *.shogo.one published URL").toBeTruthy()
    const publishedUrl = match![0]
    // The agent may name-derive the subdomain (the tool description lets it
    // propose one from the app name) rather than echo ours verbatim, so we do
    // not hard-assert the exact subdomain — only that a real .shogo.one URL was
    // returned and that it actually serves.
    // Cleanup polls whatever the agent actually published, not what we asked for.
    project.subdomain = new URL(publishedUrl).hostname.split(".")[0]
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
    const project = await createTrackedProject(page)

    // A distinctive subdomain the agent would NOT name-derive from "hello".
    const subdomain = `e2e-keepme-${Date.now().toString(36)}`
    project.subdomain = subdomain
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
    const projectA = await createTrackedProject(page)
    projectA.subdomain = subdomain
    const textA = await publishToSubdomain(page, subdomain)
    // The subdomain reservation lands in the DB at the start of publish (before
    // build/upload), so Project A holds it regardless of the known bucket infra
    // issue. We only need proof A targeted this exact subdomain.
    expect(
      textA,
      `Project A should have published to subdomain "${subdomain}"`,
    ).toContain(subdomain)

    // Project B tries to grab the same subdomain — must be rejected.
    await createTrackedProject(page)
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
