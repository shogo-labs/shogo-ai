// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test } from "@playwright/test"
import { startProjectWithBootstrapTurn } from "./helpers"
import {
  collectChatCrashes,
  expectLiveTurnRendersAfterReopen,
  installLiveTurnMocks,
  liveTurnReplay,
  throttleCpu,
} from "../shared/live-turn-replay"

/**
 * Reopen a project whose turn is still running on the server — mock E2E.
 * See e2e/shared/live-turn-replay.ts for the production incident it guards.
 *
 * The CPU is throttled because production crashes came from slow phones
 * (Sentry: Android Chrome Mobile); a fast desktop finishes each commit before
 * the next update lands and never shows the bug.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts chat-resume-replay-storm
 *
 * `E2E_REPLAY_FRAMES`, `E2E_ANSWER_LINES` and `E2E_CPU_THROTTLE` override the
 * replay size and the emulated device speed.
 */

const STEP_FRAMES = Number(process.env.E2E_REPLAY_FRAMES || 12_000)
const ANSWER_LINES = Number(process.env.E2E_ANSWER_LINES || 400)
// CI runners are already several times slower than a developer laptop.
const CPU_THROTTLE = Number(process.env.E2E_CPU_THROTTLE || (process.env.CI ? 2 : 4))
const RENDER_BUDGET_MS = 30_000


test.describe("Reopen a project with a live server-side turn — E2E (mocked)", () => {
  test("replaying a large buffered turn renders without crashing the chat panel", async ({ page }) => {
    test.setTimeout(240_000)
    const crashes = collectChatCrashes(page)
    if (process.env.E2E_DEBUG) {
      page.on("console", (msg) => {
        const text = msg.text()
        if (/resum|replay|reattach|probe|stall|recover|reconnect|turn/i.test(text)) console.log(`[page] ${text.slice(0, 240)}`)
      })
      page.on("request", (req) => {
        if (/\/(stream|turn)\b/.test(req.url())) console.log(`[req] ${req.method()} ${req.url().replace(/^.*\/chat\//, "")}`)
      })
    }
    const mocks = await installLiveTurnMocks(page, liveTurnReplay({ stepFrames: STEP_FRAMES, answerLines: ANSWER_LINES }))

    await startProjectWithBootstrapTurn(page)

    await throttleCpu(page, CPU_THROTTLE)
    await expectLiveTurnRendersAfterReopen(page, mocks, crashes, RENDER_BUDGET_MS)
  })

})
