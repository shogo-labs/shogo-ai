// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { writeFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { startProjectWithBootstrapTurn } from "./helpers"
import {
  collectChatCrashes,
  compactedReplay,
  installLiveTurnMocks,
  liveTurnReplay,
  measureLiveTurnReopen,
  throttleCpu,
} from "../shared/live-turn-replay"

/**
 * Joining a turn that is still running: the runtime replays its buffer
 * compacted (one delta per part, see packages/core/src/stream-compaction.ts),
 * so the message as it stands — with the words still being written — should
 * be on screen right after the `/stream` response arrives, not after the client
 * has rebuilt the turn chunk by chunk.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts chat-reopen-live-turn-timing
 *
 * `E2E_CPU_THROTTLE` sets the emulated device speed, `E2E_REOPEN_BUDGET_MS`
 * the budget, and `E2E_PROFILE=<file>` saves a CPU profile of the window from
 * the `/stream` request to the render.
 */

// Screen recording and trace snapshots run on the page's main thread.
test.use({ video: "off", trace: "off" })

const STEP_FRAMES = Number(process.env.E2E_REPLAY_FRAMES || 12_000)
const ANSWER_LINES = Number(process.env.E2E_ANSWER_LINES || 400)
const CPU_THROTTLE = Number(process.env.E2E_CPU_THROTTLE || (process.env.CI ? 2 : 4))
// The same emulated device measured ~0.8s on a developer laptop and 4-10s on a
// CI runner (dev bundle, shared core), so CI gets a wider budget. The gap this
// guards is minutes, not seconds: before compaction the panel rebuilt the turn
// chunk by chunk.
const BUDGET_MS = Number(process.env.E2E_REOPEN_BUDGET_MS || (process.env.CI ? 20_000 : 3_000))

test("joining a running turn shows it right after the stream responds", async ({ page }) => {
  test.setTimeout(120_000)
  const crashes = collectChatCrashes(page)
  const mocks = await installLiveTurnMocks(
    page,
    compactedReplay(liveTurnReplay({ stepFrames: STEP_FRAMES, answerLines: ANSWER_LINES })),
  )
  await startProjectWithBootstrapTurn(page)
  await throttleCpu(page, CPU_THROTTLE)

  const profilePath = process.env.E2E_PROFILE
  const cdp = profilePath ? await page.context().newCDPSession(page) : null
  if (cdp) {
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 })
    let started = false
    page.on("request", (req) => {
      if (started || !/\/chat\/[^/]+\/stream/.test(req.url())) return
      started = true
      void cdp.send("Profiler.start")
    })
  }

  const timing = await measureLiveTurnReopen(page, mocks)
  if (cdp && profilePath) writeFileSync(profilePath, JSON.stringify((await cdp.send("Profiler.stop")).profile))
  console.log(
    `[live-turn-replay] compacted cpu=${CPU_THROTTLE}x streamToRenderMs=${timing.streamToRenderMs} ` +
      `reloadToRenderMs=${timing.reloadToRenderMs} domNodesAtRender=${timing.domNodesAtRender}`,
  )

  expect(crashes, `chat panel render crashes:\n${crashes.join("\n")}`).toEqual([])
  expect(timing.streamToRenderMs, "live turn on screen after the /stream response (ms)").toBeLessThan(BUDGET_MS)
  expect(mocks.fullReplays()).toBe(1)
})
