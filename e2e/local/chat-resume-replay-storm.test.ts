// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test } from "@playwright/test"
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

// A runtime that answers `?snapshot=1` hands the client the message so far in
// one chunk, so the laptop-sized turn renders as fast on a CI runner as the
// small one. A runtime that still replays its buffer (an older deploy; the
// fallback test below) makes the client rebuild the turn chunk by chunk: a
// runner needs minutes for the full-size replay, but a few hundred chunks is
// still far past the ~50 consecutive commits that used to crash the panel. At a
// 10x CPU throttle the small replay finishes in ~35s with the pacing and
// crash-loops (4 replays) without it.
const STEP_FRAMES = Number(process.env.E2E_REPLAY_FRAMES || 12_000)
const ANSWER_LINES = Number(process.env.E2E_ANSWER_LINES || 400)
const FALLBACK_STEP_FRAMES = Number(process.env.E2E_REPLAY_FRAMES || (process.env.CI ? 1_500 : 12_000))
const FALLBACK_ANSWER_LINES = Number(process.env.E2E_ANSWER_LINES || (process.env.CI ? 50 : 400))
// CI runners are already several times slower than a developer laptop.
const CPU_THROTTLE = Number(process.env.E2E_CPU_THROTTLE || (process.env.CI ? 2 : 4))
// The budget only bounds a hang; the crash and remount checks are what catch
// the regression.
const RENDER_BUDGET_MS = Number(process.env.E2E_RENDER_BUDGET_MS || (process.env.CI ? 120_000 : 30_000))

test.describe("Reopen a project with a live server-side turn — E2E (mocked)", () => {
  test("reopening a large live turn shows it from a message snapshot without crashing the chat panel", async ({ page }) => {
    test.setTimeout(300_000)
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
    expect(mocks.snapshotRequests(), "reopening should ask the runtime for a message snapshot").toBe(1)
    expect(mocks.snapshotReplays()).toBe(1)
  })

  test("a runtime that replays its buffer instead of a snapshot still renders without crashing", async ({ page }) => {
    test.setTimeout(300_000)
    const crashes = collectChatCrashes(page)
    const mocks = await installLiveTurnMocks(
      page,
      liveTurnReplay({ stepFrames: FALLBACK_STEP_FRAMES, answerLines: FALLBACK_ANSWER_LINES }),
      { snapshot: false },
    )

    await startProjectWithBootstrapTurn(page)

    await throttleCpu(page, CPU_THROTTLE)
    await expectLiveTurnRendersAfterReopen(page, mocks, crashes, RENDER_BUDGET_MS)
    expect(mocks.snapshotRequests()).toBe(1)
    expect(mocks.snapshotReplays()).toBe(0)
  })

})
