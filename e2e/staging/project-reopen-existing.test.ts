// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type FrameLocator, type Page } from "@playwright/test"
import {
  createProjectAndWait,
  makeTestUser,
  signUpAndOnboard,
  suspendRuntimeViaApi,
  waitForAgentResponse,
  type TestUser,
} from "./helpers"

/**
 * Reopen-existing-project E2E (UI-driven)
 *
 * Guards the exact regression where reopening a previously-edited project
 * served the pristine "Project Ready" template instead of the project's saved
 * source (the metal cold-start hydration / reopen bug):
 *
 *   1. Create a project and drive the agent to write a UNIQUE marker heading
 *      into src/App.tsx (real, non-template content). Assert the preview
 *      renders it.
 *   2. Suspend the runtime via the API e2e backdoor (metal → snapshot suspend,
 *      Knative → scale-to-zero). This forces the NEXT open through the real
 *      reopen/resume path — a plain reload just re-attaches to the still-warm
 *      VM and would never catch the regression, and the natural idle-suspend
 *      reaper is ~30 min away.
 *   3. Reopen the project (navigate away, then back) and assert the UNIQUE
 *      marker STILL renders and the template markers ("Project Ready" /
 *      "Start building your app!") are absent.
 *
 * Requires the suspend backdoor (`SHOGO_E2E_BOOTSTRAP_SECRET` +
 * `/api/internal/e2e/suspend-runtime`); the reopen assertion is meaningless
 * against a warm VM, so the test skips cleanly when the backdoor is unavailable.
 *
 * Run: STAGING_URL=... SHOGO_E2E_BOOTSTRAP_SECRET=... npx playwright test \
 *   --config e2e/playwright.config.ts project-reopen-existing
 */

const TEST_USER = makeTestUser("ReopenExisting")

const PREVIEW_BOOT_TIMEOUT_MS = 120_000
const PREVIEW_CONTENT_TIMEOUT_MS = 60_000

// A per-run unique marker so a reopen can never accidentally match leftover
// content from another project/run — and is trivially distinct from the
// template's "Project Ready".
const MARKER = `Reopen Marker ${Date.now().toString(36)}`

// ── Auth (mirrors project-preview-boot.test.ts) ─────────────────────────────

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

// ── Preview helpers ─────────────────────────────────────────────────────────

function previewFrame(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="canvas-preview-iframe"]')
}

async function waitForPreviewIframe(page: Page): Promise<void> {
  await page
    .getByTestId("canvas-preview-iframe")
    .waitFor({ state: "attached", timeout: PREVIEW_BOOT_TIMEOUT_MS })
}

// ── Project chat helpers (project composer, not the home composer) ──────────

function visibleComposer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

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

/** Drive the agent to write App.tsx to a single heading equal to `heading`. */
async function setAppHeadingViaAgent(page: Page, heading: string): Promise<void> {
  await waitForAgentResponse(page)
  await sendProjectChatMessage(
    page,
    `Replace the ENTIRE contents of src/App.tsx with a minimal default-exported ` +
      `React component whose only visible content is a single <h1> with the exact ` +
      `text "${heading}". Do not add any other text, components, or files. After ` +
      `writing the file, stop.`,
  )
  await waitForAgentResponse(page)
  await waitForPreviewIframe(page)
  await expect(previewFrame(page).getByText(heading, { exact: false })).toBeVisible({
    timeout: PREVIEW_CONTENT_TIMEOUT_MS,
  })
}

async function createProjectReturningId(page: Page, prompt: string): Promise<string> {
  await createProjectAndWait(page, prompt)
  const m = page.url().match(/\/projects\/([^/?#]+)/)
  expect(m, `expected a /projects/<id> URL, got ${page.url()}`).toBeTruthy()
  return m![1]
}

// ── Test ─────────────────────────────────────────────────────────────────────

test.describe("Reopen existing project", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("reopen serves the saved source, not the template", async () => {
    test.setTimeout(360_000)

    // 1. Create a project and give it distinctive, non-template source.
    const projectId = await createProjectReturningId(page, "Reopen-existing test project")
    await page.goto(`/projects/${projectId}`)
    await setAppHeadingViaAgent(page, MARKER)

    // 2. Force a fresh runtime: suspend it out-of-band. Without the backdoor a
    //    reopen would just re-attach to the warm VM and the assertion below
    //    would be a tautology, so skip cleanly.
    const suspended = await suspendRuntimeViaApi(page, projectId)
    test.skip(
      !suspended,
      "reopen assertion requires the suspend-runtime backdoor " +
        "(SHOGO_E2E_BOOTSTRAP_SECRET). A warm-VM reload cannot catch a reopen " +
        "regression.",
    )
    // Give the substrate a moment to actually tear the runtime down.
    await page.waitForTimeout(3_000)

    // 3. Reopen: leave the project entirely, then navigate back so the runtime
    //    is resolved + resumed from scratch.
    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 30_000 })
    await page.goto(`/projects/${projectId}`)
    await waitForPreviewIframe(page)

    const frame = previewFrame(page)
    // The saved source must come back...
    await expect(frame.getByText(MARKER, { exact: false })).toBeVisible({
      timeout: PREVIEW_CONTENT_TIMEOUT_MS,
    })
    // ...and the pristine template must NOT (the regression served this).
    await expect(frame.getByText("Project Ready", { exact: false })).toHaveCount(0)
    await expect(frame.getByText("Start building your app!", { exact: false })).toHaveCount(0)
  })
})
