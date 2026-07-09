// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type FrameLocator, type Page } from "@playwright/test"
import {
  createProjectAndWait,
  homeComposerInput,
  makeTestUser,
  signUpAndOnboard,
  waitForAgentIdle,
  waitForAgentResponse,
  type TestUser,
} from "./helpers"

/**
 * Project Preview Boot & Cycle E2E (UI-driven)
 *
 * Guards the runtime → preview-iframe path that regressed into the stuck
 * "Loading preview… (this usually takes 20-40 seconds)" spinner:
 *
 *   1. Single project: a freshly created project's runtime boots and the
 *      preview iframe renders the default template — the literal
 *      "Project Ready" / "Start building your app!" from
 *      templates/runtime-template/src/App.tsx. We abort the initial agent
 *      build immediately after creation so App.tsx stays on the template
 *      (the cold-boot state), making the assertion deterministic instead
 *      of racing the agent's first edit.
 *
 *   2. Multiple projects: two projects whose App.tsx renders "Project A
 *      Ready" / "Project B Ready" respectively, then cycle between them via
 *      the top-bar project switcher and assert each project's own preview
 *      renders. This exercises that warm, distinct per-project runtimes are
 *      addressed correctly (no cross-project bleed, no duplicate-runtime
 *      regression) when navigating between projects in a workspace.
 *
 * The preview iframe is tagged `data-testid="canvas-preview-iframe"`
 * (CanvasWebView). The switcher entry points are
 * `project-switcher-trigger` → `project-switcher-open` →
 * `project-switcher-item-<id>` (ProjectTopBar).
 *
 * This suite is independent of the workspace-runtime rollout flag: the
 * per-project preview boot and the switcher both work in legacy
 * single-project and merged-workspace modes.
 *
 * Run: STAGING_URL=... npx playwright test \
 *   --config e2e/playwright.config.ts project-preview-boot
 * or locally against the dev web server on :8081.
 */

const TEST_USER = makeTestUser("PreviewBoot")

const PREVIEW_BOOT_TIMEOUT_MS = 120_000
const PREVIEW_CONTENT_TIMEOUT_MS = 60_000

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Lands on an authenticated home screen in both shapes: hosted/staging
 * (real /sign-in → signUpAndOnboard) and local desktop mode
 * (SHOGO_LOCAL_MODE=true, which boots straight to the home screen with no
 * auth). Mirrors the helper in workspace-attachments.test.ts.
 */
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

// ── Preview helpers ────────────────────────────────────────────────────────

/** The live preview iframe (CanvasWebView, web). */
function previewFrame(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="canvas-preview-iframe"]')
}

/**
 * Waits until the runtime is healthy enough that the CanvasPanel swaps the
 * "Loading preview…" placeholder for the actual iframe. The iframe is only
 * mounted once `agentUrl && readyCanvasBaseUrl` resolve, so its presence is
 * the real boot gate.
 */
async function waitForPreviewIframe(page: Page): Promise<void> {
  await page
    .getByTestId("canvas-preview-iframe")
    .waitFor({ state: "attached", timeout: PREVIEW_BOOT_TIMEOUT_MS })
}

/** The chat stop button (present only while the agent is streaming). */
function stopButton(page: Page) {
  return page.locator('[data-testid="stop-streaming"], [aria-label="Stop"]').first()
}

/**
 * Aborts the agent's in-flight build stream if it is running. Used right
 * after project creation so the runtime keeps serving the untouched
 * template App.tsx (the agent edits files on disk; stopping it before its
 * first edit lands keeps "Project Ready" on screen).
 */
async function stopAgentStreamIfRunning(page: Page): Promise<void> {
  const appeared = await stopButton(page)
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  if (appeared) {
    await stopButton(page).click({ force: true }).catch(() => {})
    await stopButton(page).waitFor({ state: "detached", timeout: 15_000 }).catch(() => {})
  }
}

/**
 * Creates a project from the home composer and aborts the initial build as
 * fast as possible, returning its project id. Leaves the runtime booting
 * with the template App.tsx intact.
 */
async function createProjectAndStop(page: Page, prompt: string): Promise<string> {
  await page.goto("/")
  await page.waitForSelector("text=What's on your mind", { timeout: 30_000 })
  const input = homeComposerInput(page)
  await input.click()
  await input.fill(prompt)
  await page.waitForTimeout(300)
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
  // Kill the build before the agent rewrites the template.
  await stopAgentStreamIfRunning(page)
  const m = page.url().match(/\/projects\/([^/?#]+)/)
  expect(m, `expected a /projects/<id> URL, got ${page.url()}`).toBeTruthy()
  return m![1]
}

/**
 * Creates a project, lets the initial build run, parses its id and returns
 * it. Used for the multi-project case where we then drive the agent to set
 * a distinct App.tsx.
 */
async function createProjectReturningId(page: Page, prompt: string): Promise<string> {
  await createProjectAndWait(page, prompt)
  const m = page.url().match(/\/projects\/([^/?#]+)/)
  expect(m, `expected a /projects/<id> URL, got ${page.url()}`).toBeTruthy()
  return m![1]
}

// ── Project chat helpers (project composer, not the home composer) ───────────

/** The currently-visible project chat composer. */
function visibleComposer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

/** Sends a message into the project chat composer and waits for it to land. */
async function sendProjectChatMessage(page: Page, text: string): Promise<void> {
  const snippet = text.slice(0, 24)
  for (let attempt = 0; attempt < 3; attempt++) {
    // A follow-up must never be sent while the previous turn is still streaming:
    // the composer shows a "Queue message" button (not "Send message") and the
    // input can be non-editable. Wait for the agent to go idle first.
    await waitForAgentIdle(page)
    const box = visibleComposer(page)
    await box.waitFor({ state: "visible", timeout: 15_000 })
    await box.fill(text)
    // "Send message" only exists once idle + the input has text. If it's not
    // there, the agent likely resumed streaming (or the input was disabled) —
    // loop back and wait for idle again.
    const sendBtn = page
      .getByRole("button", { name: "Send message" })
      .filter({ visible: true })
      .first()
    const ready = await sendBtn
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (!ready) continue
    await sendBtn.click({ force: true })
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

/**
 * Reloads the preview iframe and waits for it to render `heading`, retrying the
 * reload until the timeout.
 *
 * The preview does NOT auto-refresh after the agent edits source: the in-iframe
 * canvas-bridge shows a manual "Update available — Refresh" pill on the
 * runtime's SSE `reload` event (refreshBtn → window.location.reload()) and
 * deliberately does not reload on its own so it won't disrupt a user
 * mid-interaction. So a test that edits source must drive the reload itself —
 * clicking the top-bar "Refresh preview" control (BarIconButton, aria-label
 * "Refresh preview") — before the new content is observable. We retry because
 * the runtime's rebuild of dist/ can land slightly after the agent says "Done".
 */
async function expectPreviewHeading(page: Page, heading: string): Promise<void> {
  await waitForPreviewIframe(page)
  const deadline = Date.now() + PREVIEW_CONTENT_TIMEOUT_MS
  let lastErr: unknown
  while (Date.now() < deadline) {
    await page.getByLabel("Refresh preview").first().click({ force: true }).catch(() => {})
    const ok = await previewFrame(page)
      .getByText(heading, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch((e) => {
        lastErr = e
        return false
      })
    if (ok) return
    await page.waitForTimeout(1_500)
  }
  throw new Error(`preview never rendered "${heading}" after refresh: ${String(lastErr)}`)
}

/**
 * Drives the agent to replace src/App.tsx so the preview renders a single
 * heading exactly equal to `heading`, then waits for the agent to finish and
 * reloads the preview iframe to show it.
 */
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
  await expectPreviewHeading(page, heading)
}

// ── Project switcher (the "cycle through projects" control) ──────────────────

/**
 * Switches the active project via the top-bar project switcher dropdown:
 * trigger → "Switch project" → the target row. RN-web Popovers can swallow
 * the first synthetic click, so the open step retries.
 */
async function switchToProject(page: Page, projectId: string): Promise<void> {
  const trigger = page.getByTestId("project-switcher-trigger").first()
  const openSwitcher = page.getByTestId("project-switcher-open").first()
  const targetRow = page.getByTestId(`project-switcher-item-${projectId}`).first()

  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click({ force: true })
    const menuOpen = await openSwitcher
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
    if (menuOpen) break
    await page.waitForTimeout(300)
  }
  await openSwitcher.click({ force: true })
  await targetRow.waitFor({ state: "visible", timeout: 10_000 })
  await targetRow.click({ force: true })
  await page.waitForURL(new RegExp(`/projects/${projectId}(?:[/?#]|$)`), { timeout: 30_000 })
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe("Project preview boot & cycle", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("single project boots and the preview iframe shows the template", async () => {
    test.setTimeout(180_000)
    await createProjectAndStop(page, "A simple starter project for preview-boot testing")

    await waitForPreviewIframe(page)
    const frame = previewFrame(page)
    await expect(frame.getByText("Project Ready", { exact: false })).toBeVisible({
      timeout: PREVIEW_CONTENT_TIMEOUT_MS,
    })
    await expect(frame.getByText("Start building your app!", { exact: false })).toBeVisible({
      timeout: PREVIEW_CONTENT_TIMEOUT_MS,
    })
  })

  test("two projects render distinct previews and cycle via the switcher", async () => {
    test.setTimeout(480_000)

    // Minimal seed prompts: the initial build content is irrelevant here — we
    // overwrite App.tsx via setAppHeadingViaAgent — and an open-ended prompt
    // sends the agent off on a multi-minute build that risks overrunning the
    // budget.
    const SEED = "Create the simplest possible starter app: a single page that shows the word Hello. Do not add any extra pages, components, features, or backend."

    // Project A → "Project A Ready"
    const projectA = await createProjectReturningId(page, SEED)
    await page.goto(`/projects/${projectA}`)
    await setAppHeadingViaAgent(page, "Project A Ready")

    // Project B → "Project B Ready"
    const projectB = await createProjectReturningId(page, SEED)
    await page.goto(`/projects/${projectB}`)
    await setAppHeadingViaAgent(page, "Project B Ready")

    expect(projectA).not.toBe(projectB)

    // We are on B. Cycle B → A and assert A's preview.
    await switchToProject(page, projectA)
    await expectPreviewHeading(page, "Project A Ready")
    await expect(
      previewFrame(page).getByText("Project B Ready", { exact: false }),
    ).toHaveCount(0)

    // Cycle A → B and assert B's preview.
    await switchToProject(page, projectB)
    await expectPreviewHeading(page, "Project B Ready")
    await expect(
      previewFrame(page).getByText("Project A Ready", { exact: false }),
    ).toHaveCount(0)
  })
})
