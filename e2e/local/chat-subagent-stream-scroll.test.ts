// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page } from "@playwright/test"
import { startProjectWithBootstrapTurn } from "./helpers"
import {
  collectChatCrashes,
  installLiveTurnMocks,
  liveTurnReplay,
  REPLAY_TAIL,
  SUBAGENT_LIVE_MARKER,
  throttleCpu,
} from "../shared/live-turn-replay"

/**
 * A long `browser_qa` run must not freeze the chat (SHO-340).
 *
 * The runtime used to re-send the sub-agent's whole transcript on every text
 * delta and every tool transition, so each frame grew with the run and the
 * client spent all its time parsing and re-rendering. This replays a 160-step
 * browser_qa transcript (each step a snapshot-sized result) and requires the
 * transcript to stay scrollable and the composer to stay responsive.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts chat-subagent-stream-scroll
 *
 * `E2E_SUBAGENT_STEPS` and `E2E_CPU_THROTTLE` override the run size and the
 * emulated device speed.
 */

test.use({ video: "off", trace: "off" })

const SUBAGENT_STEPS = Number(process.env.E2E_SUBAGENT_STEPS || 160)
const CPU_THROTTLE = Number(process.env.E2E_CPU_THROTTLE || (process.env.CI ? 2 : 4))
/** A scroll or a keystroke that takes longer than this is a frozen UI. */
const INTERACTION_BUDGET_MS = Number(process.env.E2E_INTERACTION_BUDGET_MS || (process.env.CI ? 4_000 : 1_500))

/**
 * The chat's scroll container, found from the transcript itself: the nearest
 * ancestor that actually scrolls. The panel has no test id for it, and a
 * hard-coded class would break on the next layout change.
 */
async function scrollMetrics(page: Page) {
  return page.evaluate((tail) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null = walker.nextNode()
    let anchor: HTMLElement | null = null
    while (node) {
      if (node.textContent?.includes(tail)) {
        anchor = node.parentElement
        break
      }
      node = walker.nextNode()
    }
    if (!anchor) return null
    let el: HTMLElement | null = anchor
    while (el && el !== document.body) {
      const style = getComputedStyle(el)
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20) break
      el = el.parentElement
    }
    if (!el || el === document.body) return null
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  }, REPLAY_TAIL)
}

async function scrollTo(page: Page, where: "top" | "bottom") {
  return page.evaluate(
    ({ tail, where }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node: Node | null = walker.nextNode()
      let anchor: HTMLElement | null = null
      while (node) {
        if (node.textContent?.includes(tail)) {
          anchor = node.parentElement
          break
        }
        node = walker.nextNode()
      }
      if (!anchor) return null
      let el: HTMLElement | null = anchor
      while (el && el !== document.body) {
        const style = getComputedStyle(el)
        if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20) break
        el = el.parentElement
      }
      if (!el || el === document.body) return null
      el.scrollTop = where === "top" ? 0 : el.scrollHeight
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
    },
    { tail: REPLAY_TAIL, where },
  )
}

test("a long browser_qa transcript keeps the chat scrollable and the composer responsive", async ({ page }) => {
  test.setTimeout(240_000)
  const crashes = collectChatCrashes(page)
  const mocks = await installLiveTurnMocks(
    page,
    liveTurnReplay({ stepFrames: 400, answerLines: 40, subagentSteps: SUBAGENT_STEPS }),
  )

  await startProjectWithBootstrapTurn(page)
  await throttleCpu(page, CPU_THROTTLE)

  // Join the running turn: the runtime serves the message so far, including the
  // sub-agent's current transcript.
  mocks.goLive()
  await page.reload()
  await expect(page.getByText(REPLAY_TAIL, { exact: false })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText(SUBAGENT_LIVE_MARKER, { exact: false }).first()).toBeVisible({ timeout: 30_000 })

  const before = await scrollMetrics(page)
  expect(before, "the transcript has no scroll container").not.toBeNull()
  expect(before!.scrollHeight, "the transcript is not long enough to scroll").toBeGreaterThan(before!.clientHeight + 200)

  // Scroll to the top and back, timing each move: a starved main thread leaves
  // the scroll position where it was.
  const topStartedAt = Date.now()
  const top = await scrollTo(page, "top")
  expect(top!.scrollTop).toBeLessThan(5)
  const topMs = Date.now() - topStartedAt

  const bottomStartedAt = Date.now()
  const bottom = await scrollTo(page, "bottom")
  expect(bottom!.scrollTop).toBeGreaterThan(bottom!.scrollHeight - bottom!.clientHeight - 5)
  const bottomMs = Date.now() - bottomStartedAt

  // A keystroke must show up in the composer while the transcript is on screen.
  const composer = page.getByTestId("project-composer-input").first()
  await composer.click()
  const typedAt = Date.now()
  await page.keyboard.type("x")
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-testid="project-composer-input"]') as HTMLTextAreaElement | null
          return el?.value ?? ""
        }),
      { timeout: INTERACTION_BUDGET_MS },
    )
    .toContain("x")
  const keystrokeMs = Date.now() - typedAt

  console.log(
    `[subagent-stream] steps=${SUBAGENT_STEPS} cpu=${CPU_THROTTLE}x scrollTopMs=${topMs} ` +
      `scrollBottomMs=${bottomMs} keystrokeMs=${keystrokeMs} scrollHeight=${before!.scrollHeight}`,
  )

  expect(crashes, `chat panel render crashes:\n${crashes.join("\n")}`).toEqual([])
  expect(topMs, "scrolling to the top of the transcript (ms)").toBeLessThan(INTERACTION_BUDGET_MS)
  expect(bottomMs, "scrolling back to the bottom of the transcript (ms)").toBeLessThan(INTERACTION_BUDGET_MS)
  expect(keystrokeMs, "a composer keystroke showing up (ms)").toBeLessThan(INTERACTION_BUDGET_MS)
})
