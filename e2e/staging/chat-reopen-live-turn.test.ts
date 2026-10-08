// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, type Page } from "./fixtures"
import { homeComposerInput, makeTestUser, signUpAndOnboard, type TestUser } from "./helpers"
import {
  collectChatCrashes,
  expectLiveTurnRendersAfterReopen,
  installLiveTurnMocks,
  liveTurnReplay,
  throttleCpu,
} from "../shared/live-turn-replay"

/**
 * Reopen a project whose turn is still running, against the deployed
 * production bundle (minified React, real streamdown build) at phone CPU
 * speed. The turn itself is mocked in the browser — a large buffered replay
 * shaped like the runtime's output — so the test is deterministic and needs no
 * model. See e2e/shared/live-turn-replay.ts for the incident it guards; the
 * same check runs in e2e/local on every PR against the dev bundle.
 *
 * Run: E2E_TARGET_URL=... npx playwright test --config e2e/playwright.config.ts chat-reopen-live-turn
 */

const TEST_USER = makeTestUser("ReopenLiveTurn")
const CPU_THROTTLE = 4
const RENDER_BUDGET_MS = 30_000

async function ensureAuthenticated(page: Page, user: TestUser): Promise<void> {
  await page.goto("/")
  const home = page.getByText("What are we building", { exact: false }).first()
  const signUpTab = page.getByRole("tab", { name: "Sign Up" })
  await Promise.race([
    home.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    signUpTab.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
  ])
  if (await home.isVisible().catch(() => false)) return
  await signUpAndOnboard(page, user)
}

test.describe("Reopen a project with a live turn", () => {
  test("a large buffered turn renders on a slow CPU without crashing the chat panel", async ({ page }) => {
    test.setTimeout(300_000)
    const crashes = collectChatCrashes(page)
    await ensureAuthenticated(page, TEST_USER)
    const mocks = await installLiveTurnMocks(page, liveTurnReplay({ stepFrames: 12_000, answerLines: 400 }))

    const input = homeComposerInput(page)
    await input.click()
    await input.fill("Build a tiny app for the reopen-live-turn E2E")
    await page.keyboard.press("Enter")
    await page.waitForURL(/\/projects\//, { timeout: 60_000 })
    await page.getByText("Bootstrap done.").waitFor({ state: "visible", timeout: 60_000 })

    await throttleCpu(page, CPU_THROTTLE)
    await expectLiveTurnRendersAfterReopen(page, mocks, crashes, RENDER_BUDGET_MS)
  })
})
