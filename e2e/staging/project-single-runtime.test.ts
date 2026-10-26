// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import { ensureAuthenticated, sendProjectChatMessage, transcript } from "./agent-chat"
import {
  createProjectAndWait,
  makeTestUser,
  NO_BUILD_PROJECT_PROMPT,
  runtimeHoldersViaApi,
  suspendRuntimeViaApi,
  waitForAgentResponse,
} from "./helpers"

/**
 * Single-runtime projects E2E: on metal a project is online ONLY in its own
 * runtime (`ws:proj:<id>`). Another project's agent reaches it through the
 * remote project channel (file/exec tools with a `project` param), never by
 * mounting it into its own runtime.
 *
 *   1. A's agent writes a file into B over the channel. Each project is then
 *      held by exactly one runtime, its own.
 *   2. Regression for the 2026-10-14 cold-boot incident: after A's agent has
 *      edited B, suspending and reopening A must resume in < 15s; the same for
 *      B, whose file must carry the edit.
 *
 * Runtime holders and suspends go through `/api/internal/e2e/*`, which needs
 * `SHOGO_E2E_BOOTSTRAP_SECRET`. The suite skips without it.
 *
 * Run: E2E_TARGET_URL=... SHOGO_E2E_BOOTSTRAP_SECRET=... \
 *   npx playwright test --config e2e/playwright.config.ts project-single-runtime
 */

const TEST_USER = makeTestUser("SingleRuntime")
const RUN = Date.now().toString(36)
const CHANNEL_FILE = "SHOGO_E2E_CHANNEL.md"
const WRITE_MARKER = `channel-write-${RUN}`
const EDIT_MARKER = `channel-edited-${RUN}`

const RESUME_BUDGET_MS = 15_000

async function createProjectReturningId(page: Page): Promise<string> {
  await createProjectAndWait(page, NO_BUILD_PROJECT_PROMPT)
  const id = page.url().match(/\/projects\/([^/?#]+)/)?.[1] ?? ""
  expect(id, `expected a /projects/<id> URL, got ${page.url()}`).not.toBe("")
  return id
}

/** Navigates to a project and waits for its chat composer and any in-flight turn. */
async function openProjectChat(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`)
  await page
    .getByTestId("workspace-chat-loading")
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => {})
  await page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 })
  await waitForAgentResponse(page)
}

async function expectSoleHolder(page: Page, projectId: string): Promise<void> {
  const r = await runtimeHoldersViaApi(page, projectId)
  test.skip(!r, "runtime-holders endpoint unavailable on this target")
  expect(r!.projectId).toBe(projectId)
  expect(
    r!.holders.map((h) => h.runtimeKey),
    `holders of ${projectId}: ${JSON.stringify(r!.holders)}`,
  ).toEqual([`ws:proj:${projectId}`])
}

/**
 * Opens `projectId` from the home screen and returns the ms from navigation
 * until its `/sandbox/url` answers `ready: true` (the client polls it while the
 * runtime starts; earlier polls answer 202 / `ready: false`).
 */
async function timeOpenUntilReady(page: Page, projectId: string): Promise<number> {
  const ready = page.waitForResponse(
    async (res) => {
      if (!res.url().includes(`/api/projects/${projectId}/sandbox/url`) || res.status() !== 200) return false
      const body = await res.json().catch(() => null)
      return body?.ready === true
    },
    { timeout: 180_000 },
  )
  const started = Date.now()
  await page.goto(`/projects/${projectId}`)
  await ready
  return Date.now() - started
}

/**
 * Suspends `projectId` with no page holding it open, so nothing (preview,
 * chat stream, status poll) wakes it before the timed reopen.
 */
async function suspendFromHome(page: Page, projectId: string): Promise<void> {
  await page.goto("/home")
  await page.waitForSelector("text=What are we building", { timeout: 60_000 })
  expect(await suspendRuntimeViaApi(page, projectId), "runtime must really suspend").toBe(true)
}

test.describe("Single-runtime projects (remote project channel)", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let projectA = ""
  let projectB = ""

  test.beforeAll(async ({ browser }) => {
    test.skip(!process.env.SHOGO_E2E_BOOTSTRAP_SECRET, "needs SHOGO_E2E_BOOTSTRAP_SECRET for the e2e backdoor")
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("A writes into B over the channel; each project is held only by its own runtime", async () => {
    test.setTimeout(600_000)
    projectA = await createProjectReturningId(page)
    projectB = await createProjectReturningId(page)
    expect(projectA).not.toBe(projectB)

    await openProjectChat(page, projectA)
    await sendProjectChatMessage(
      page,
      `Using write_file with the project parameter set to "${projectB}", create ${CHANNEL_FILE} ` +
        `in that project's root containing the single line "${WRITE_MARKER}". ` +
        `Do not write it into your own project. Then confirm it was written.`,
    )
    await waitForAgentResponse(page)
    const text = await transcript(page)
    expect(text).not.toContain("not allowed")
    expect(text).not.toContain("outside the workspace")

    // B was woken by the channel write; neither it nor A may also be online
    // inside the other's runtime.
    await expectSoleHolder(page, projectB)
    await expectSoleHolder(page, projectA)
  })

  test("cold-boot regression: A and B each resume in < 15s after a channel edit", async () => {
    test.setTimeout(900_000)

    await openProjectChat(page, projectA)
    await sendProjectChatMessage(
      page,
      `Using edit_file with the project parameter set to "${projectB}", edit ${CHANNEL_FILE} in that ` +
        `project so its only line reads "${EDIT_MARKER}". Do not touch your own project. Then confirm.`,
    )
    await waitForAgentResponse(page)
    expect(await transcript(page)).not.toContain("not allowed")

    await suspendFromHome(page, projectA)
    const aMs = await timeOpenUntilReady(page, projectA)
    console.log(`[single-runtime] A resumed (sandbox/url ready) in ${aMs}ms`)
    expect(aMs, `A took ${aMs}ms to resume`).toBeLessThan(RESUME_BUDGET_MS)
    await expectSoleHolder(page, projectA)

    await suspendFromHome(page, projectB)
    const bMs = await timeOpenUntilReady(page, projectB)
    console.log(`[single-runtime] B resumed (sandbox/url ready) in ${bMs}ms`)
    expect(bMs, `B took ${bMs}ms to resume`).toBeLessThan(RESUME_BUDGET_MS)
    await expectSoleHolder(page, projectB)

    await openProjectChat(page, projectB)
    await sendProjectChatMessage(
      page,
      `Read the file ${CHANNEL_FILE} in your workspace root and quote its full contents verbatim.`,
    )
    await waitForAgentResponse(page)
    expect(await transcript(page)).toContain(EDIT_MARKER)
  })
})
