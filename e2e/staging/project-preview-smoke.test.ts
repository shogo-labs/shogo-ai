// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type FrameLocator, type Page } from "@playwright/test"
import {
  homeComposerInput,
  makeTestUser,
  signUpAndOnboard,
  type TestUser,
} from "./helpers"

/**
 * Preview iframe smoke test (UI-driven, single flow).
 *
 * The minimal end-to-end guard for the "Loading preview… (this usually takes
 * 20-40 seconds)" hang: create a brand-new project from the home composer and
 * assert the live-preview iframe actually mounts and renders the default
 * runtime template — the literal "Project Ready" / "Start building your app!"
 * from templates/runtime-template/src/App.tsx.
 *
 * We stop the agent's initial build as soon as it starts so App.tsx stays on
 * the untouched template (the cold-boot state), which makes the text
 * assertion deterministic instead of racing the agent's first edit.
 *
 * Run (against the local web dev server on :8081):
 *   npx playwright test --config e2e/playwright.config.ts project-preview-smoke
 * or point at a hosted env:
 *   E2E_TARGET_URL=https://studio.staging.shogo.ai \
 *     npx playwright test --config e2e/playwright.config.ts project-preview-smoke
 */

const TEST_USER = makeTestUser("PreviewSmoke")

const PREVIEW_BOOT_TIMEOUT_MS = 120_000
const PREVIEW_CONTENT_TIMEOUT_MS = 60_000

/** The live preview iframe (CanvasWebView, web). */
function previewFrame(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="canvas-preview-iframe"]')
}

/** The chat stop button (present only while the agent is streaming). */
function stopButton(page: Page) {
  return page.locator('[data-testid="stop-streaming"], [aria-label="Stop"]').first()
}

/**
 * Lands on an authenticated home screen in both shapes: hosted/staging
 * (real /sign-in → signUpAndOnboard) and local desktop mode
 * (SHOGO_LOCAL_MODE=true, which boots straight to the home screen with no
 * auth).
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

/** Aborts the agent's in-flight build so the runtime keeps serving the template. */
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

test("new project boots and the preview iframe shows the template", async ({ page }) => {
  test.setTimeout(240_000)

  await ensureAuthenticated(page, TEST_USER)

  // Create a project from the home composer.
  await page.goto("/")
  await page.waitForSelector("text=What's on your mind", { timeout: 30_000 })
  const input = homeComposerInput(page)
  await input.click()
  await input.fill("A simple starter project for preview smoke testing")
  await page.waitForTimeout(300)
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })

  // Kill the build before the agent rewrites the template so "Project Ready"
  // stays on screen.
  await stopAgentStreamIfRunning(page)

  // The iframe only mounts once `agentUrl && readyCanvasBaseUrl` resolve, so
  // its presence is the real boot gate (this is what regressed into the stuck
  // "Loading preview…" spinner).
  await page
    .getByTestId("canvas-preview-iframe")
    .waitFor({ state: "attached", timeout: PREVIEW_BOOT_TIMEOUT_MS })

  const frame = previewFrame(page)
  await expect(frame.getByText("Project Ready", { exact: false })).toBeVisible({
    timeout: PREVIEW_CONTENT_TIMEOUT_MS,
  })
  await expect(
    frame.getByText("Start building your app!", { exact: false }),
  ).toBeVisible({ timeout: PREVIEW_CONTENT_TIMEOUT_MS })
})
