// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import { makeTestUser, MINIMAL_APP_PROMPT, publishDomain, waitForAgentResponse } from "./helpers"
import { publishRequestTimeoutMs } from "../../packages/shared-runtime/src/publish-timeouts"
import {
  INITIAL_BUILD_TIMEOUT_MS,
  LOCALHOST_RE,
  PUBLISHED_URL_RE,
  agentMessageText,
  createProject,
  ensureAuthenticated,
  sendProjectChatMessage,
} from "./agent-chat"

/**
 * Agent one-click publish (UI-driven, hosted env, Pro plan).
 *
 * Asking the agent to "publish" deploys to `{subdomain}.{PUBLISH_DOMAIN}` (the
 * target's apex — `staging.shogo.one` on staging, `shogo.one` elsewhere) and
 * returns the live URL. Publishing to a subdomain is Pro+ (the API answers
 * `plan_not_allowed` on Free), so the account is upgraded before any test runs.
 *
 * Run against staging:
 *   E2E_TARGET_URL=https://studio.staging.shogo.ai E2E_STRIPE_MODE=test \
 *     bunx playwright test --config e2e/playwright.config.ts agent-publish
 *
 * Every assertion here reads the agent's own messages (`agentMessageText`),
 * never the page body: the body also carries the user's echoed prompt, and the
 * publish prompt names the requested subdomain — so a whole-page read makes the
 * "agent must use the requested subdomain" guarantee pass on the echo alone,
 * even when the agent published somewhere else entirely (SHO-132). The guard
 * test in agent-localhost-publish.test.ts pins this at source level.
 */

const TEST_USER = makeTestUser("PublishPro")

/** The message `publishToSubdomain` sends — shared with the stubbed tests below. */
function publishPrompt(subdomain: string): string {
  return (
    `Publish this app now to the subdomain "${subdomain}". ` +
    `I confirm that exact subdomain — use it verbatim, do not pick a ` +
    `different name. Go ahead and publish immediately without asking me to ` +
    `confirm again, then reply with the live URL.`
  )
}

/**
 * Asks the agent to publish to an explicit subdomain and waits for it, returning
 * the agent's own reply — not the page body, whose echoed prompt would satisfy
 * every subdomain assertion below by construction (SHO-132).
 */
async function publishToSubdomain(page: Page, subdomain: string): Promise<string> {
  await sendProjectChatMessage(page, publishPrompt(subdomain))
  // Publish builds/uploads/provisions (slow) on the happy path; a taken
  // subdomain is rejected fast, well before that. Budget the wait from the
  // API's own step timeouts instead of a literal: a 300 s cap was shorter than
  // a legitimate staging publish, so a slow-but-working publish looked like a
  // timeout and the collision test then had nothing to collide with (SHO-207).
  await waitForAgentResponse(page, publishRequestTimeoutMs())
  return agentMessageText(page)
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Apex published apps live under for this target (`staging.shogo.one` on
 * staging, `shogo.one` elsewhere) — see helpers.publishDomain (SHO-207).
 */
const PUBLISH_DOMAIN = publishDomain()

/**
 * The product promise of "agent honors a user-provided subdomain verbatim": the
 * agent uses the name the user gave it, and every `*.shogo.one` URL it surfaces
 * is that name. A plain function over text so the stubbed tests at the bottom of
 * this file can prove it really fails on a substituted name.
 *
 * Subdomains are case-insensitive, so both sides are lowercased — a reply that
 * capitalizes the requested name is not a substitution.
 */
function assertSubdomainVerbatim(text: string, subdomain: string): void {
  const reply = text.toLowerCase()
  const wanted = subdomain.toLowerCase()
  expect(
    reply,
    `agent must use the requested subdomain "${subdomain}", not substitute its own`,
  ).toContain(wanted)
  // Any *.shogo.one URL it surfaced must be that subdomain — not a foreign one.
  for (const m of reply.matchAll(new RegExp(`https?:\\/\\/([a-z0-9-]+)\\.${escapeRegExp(PUBLISH_DOMAIN)}`, "gi"))) {
    expect(
      m[1],
      `agent published to "${m[1]}.${PUBLISH_DOMAIN}" instead of requested "${subdomain}"`,
    ).toBe(wanted)
  }
}

/**
 * "publishing a subdomain already taken by another project fails": the agent
 * says the name is taken and does not claim a live publish on it. Same plain
 * function so the stubbed tests below cover both halves.
 */
function assertSubdomainTaken(text: string, subdomain: string): void {
  // The agent must surface that the subdomain is taken …
  expect(text, "agent should report that the subdomain is already in use").toMatch(
    /already in use|already taken|is taken|not available|in use|unavailable/i,
  )
  // … and must NOT claim the project is now live on that subdomain.
  expect(
    text,
    "agent must not falsely report a successful publish to a taken subdomain",
  ).not.toMatch(new RegExp(`live at[^\\n]*${escapeRegExp(subdomain)}\\.${escapeRegExp(PUBLISH_DOMAIN)}`, "i"))
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
  const url = `https://${subdomain}.${PUBLISH_DOMAIN}/`
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
    .get(`https://${subdomain}.${PUBLISH_DOMAIN}/`, {
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
            `${subdomain}.${PUBLISH_DOMAIN}: it answered ${before?.status ?? "nothing"} ` +
            `BEFORE the delete, so a 404 now proves nothing. This environment ` +
            `does not serve published sites (staging bucket/edge mismatch) — the ` +
            `check only means something where a publish actually goes live.`,
        )
        continue
      }
      if (status !== 404 && status !== 410) {
        failures.push(
          `${subdomain}.${PUBLISH_DOMAIN} served ${before.status} before its project was ` +
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
    // The agent may name-derive the subdomain on a FIRST publish (the tool
    // description lets it propose one from the app name), so this test only
    // claims a real, serving .shogo.one URL came back — that is the whole of
    // its assertion, so tolerating a derived name here cannot mask a broken
    // promise. The verbatim guarantee is the next test, and it asserts on the
    // agent's own reply, not the prompt (SHO-132).
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
    // The agent's reply only — the prompt we sent names this subdomain, so
    // reading the page body would satisfy the assertion below no matter where
    // the agent actually published (SHO-132).
    const text = await publishToSubdomain(page, subdomain)

    // The agent must publish to the EXACT subdomain the user named — never
    // substitute a derived name. We assert on the subdomain (the behavior we
    // control) rather than reachability, which currently depends on a known
    // publish-bucket infra issue tracked separately.
    assertSubdomainVerbatim(text, subdomain)
  })

  test("publishing a subdomain already taken by another project fails", async () => {
    test.setTimeout(720_000)

    const subdomain = `e2e-dup-${Date.now().toString(36)}`

    // Project A publishes and must actually RESERVE the subdomain. The
    // reservation is written to the DB at the END of A's pipeline (after build,
    // upload and configure) — not at the start, as this test used to assume.
    // So assert it through the API here, before creating B: if A's publish
    // failed we fail right here with A's own state instead of silently giving B
    // nothing to collide with and timing out on B (SHO-207).
    const projectA = await createTrackedProject(page)
    projectA.subdomain = subdomain
    const textA = await publishToSubdomain(page, subdomain)
    assertSubdomainVerbatim(textA, subdomain)

    const reserved = await page.request.get(`/api/projects/${projectA.id}/publish`)
    expect(reserved.ok(), `GET publish state for A returned ${reserved.status()}`).toBe(true)
    const state = (await reserved.json()) as { subdomain?: string; publishStatus?: string }
    expect(
      state.subdomain,
      `project A must hold "${subdomain}" before B tries it (publishStatus: ${state.publishStatus})`,
    ).toBe(subdomain)

    // Project B tries to grab the same subdomain — must be rejected.
    await createTrackedProject(page)
    const textB = await publishToSubdomain(page, subdomain)

    // The agent must surface that the subdomain is taken, and must not claim
    // Project B is now live on it.
    assertSubdomainTaken(textB, subdomain)
  })
})

/**
 * The assertions above, on strings — no browser, no Pro account, no live
 * publish. A test that cannot fail is worse than no test (SHO-132), so the
 * substituted-subdomain reply that the old whole-page scope let through is
 * pinned here: if `assertSubdomainVerbatim` ever stops rejecting it, this reds
 * locally instead of passing a broken agent on staging.
 */
test.describe("Agent publish subdomain assertions", () => {
  const REQUESTED = "e2e-keepme-requested"

  test("a reply that names a different subdomain fails", () => {
    // Answers with its own name and never types a URL — nothing for the URL
    // loop to reject, so the name check itself has to catch it.
    const reply = `Done — I published it to "e2e-keepme-other", which is shorter and reads better.`
    expect(() => assertSubdomainVerbatim(reply, REQUESTED)).toThrow(
      /must use the requested subdomain/,
    )
  })

  test("a substituted *.shogo.one URL fails even when the reply names the request", () => {
    // Prose satisfies the plain `toContain`; only the URL loop can catch the
    // substitution, which is exactly the hole the whole-page scope hid.
    const reply =
      `Publishing "${REQUESTED}" as you asked — your app is live at ` +
      `https://e2e-keepme-other.${PUBLISH_DOMAIN}`
    expect(reply).toContain(REQUESTED)
    expect(() => assertSubdomainVerbatim(reply, REQUESTED)).toThrow(/instead of requested/)
  })

  test("a reply that used the requested subdomain passes", () => {
    expect(() =>
      assertSubdomainVerbatim(
        `Published — https://${REQUESTED}.${PUBLISH_DOMAIN} is serving 200.`,
        REQUESTED,
      ),
    ).not.toThrow()
    // A reply that names the subdomain without printing a URL is also a pass:
    // the URL loop only has something to reject when a URL is there.
    expect(() => assertSubdomainVerbatim(`Published to "${REQUESTED}".`, REQUESTED)).not.toThrow()
    // Case is not a substitution — DNS names are case-insensitive.
    expect(() =>
      assertSubdomainVerbatim(`Live at https://${REQUESTED.toUpperCase()}.${PUBLISH_DOMAIN}`, REQUESTED),
    ).not.toThrow()
  })

  test("the echoed prompt cannot stand in for the agent's reply", () => {
    // The prompt we send names the requested subdomain. That echo is what made
    // the old whole-page scope unfalsifiable: it passed for a reply that never
    // mentioned the name at all, let alone used it.
    const prompt = publishPrompt(REQUESTED)
    expect(prompt).toContain(REQUESTED)
    const reply = "Your app is published and now live on its *.shogo.one URL."
    expect(() => assertSubdomainVerbatim(reply, REQUESTED)).toThrow(
      /must use the requested subdomain/,
    )
  })

  test("a reply that reports the subdomain as taken passes", () => {
    expect(() =>
      assertSubdomainTaken(
        `"${REQUESTED}" is already in use by another project — pick a different name.`,
        REQUESTED,
      ),
    ).not.toThrow()
    expect(() =>
      assertSubdomainTaken("That subdomain is already taken, so I did not publish.", REQUESTED),
    ).not.toThrow()
  })

  test("a reply that calls it taken and also claims a live publish fails", () => {
    // The plausible wrong answer: report the clash, then claim success anyway.
    const reply =
      `The subdomain is already in use elsewhere, but I published anyway — ` +
      `it is live at https://${REQUESTED}.${PUBLISH_DOMAIN}`
    expect(() => assertSubdomainTaken(reply, REQUESTED)).toThrow(/must not falsely report/)
  })
})
