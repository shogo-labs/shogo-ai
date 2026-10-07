// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, type Page, type Route } from "@playwright/test"
import { compactSseFrames, encodeTurnSeqFrame } from "../../packages/core/src/stream-compaction"

/**
 * Reopening a project whose turn is still running on the server, with the
 * bootstrap POST, the `/turn` probe and the `/stream` replay mocked in the
 * browser. Shared by e2e/local (CI on every PR) and e2e/staging (the critical
 * path, against the production bundle).
 *
 * Production shape (2026-10-07, India users): a long turn's POST stream was cut
 * server-side at 90s while the agent kept running. Every reopen probed `/turn`,
 * saw `active`, and called `resumeStream()`, which replays the runtime's buffer
 * from seq 0 — tens of thousands of chunks. On a phone the replay either froze
 * the panel (stop button up, nothing rendered) or threw "Maximum update depth
 * exceeded" (Sentry JAVASCRIPT-REACT-5S) and the panel cycled "Chat encountered
 * an error" → "Recovering Chat..." → replay → crash.
 */

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const STREAM_GLOB = "**/api/{projects,workspaces}/*/chat/*/stream*"

export const REPLAY_TAIL = "replay-tail-marker"
const TURN_ID = "turn_live"
const HELD_STREAM_MS = 90_000

export interface LiveTurnReplayOptions {
  /** Frames for the work steps (reasoning, tool calls, usage). */
  stepFrames: number
  /** Lines of the final markdown answer, streamed a few characters at a time. */
  answerLines: number
}

function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

function completedTurn(text: string): string {
  return [
    sseFrame({ type: "start", messageId: "msg_bootstrap" }),
    sseFrame({ type: "start-step" }),
    sseFrame({ type: "text-start", id: "t_bootstrap" }),
    sseFrame({ type: "text-delta", id: "t_bootstrap", delta: text }),
    sseFrame({ type: "text-end", id: "t_bootstrap" }),
    sseFrame({ type: "finish-step" }),
    sseFrame({ type: "finish" }),
  ].join("")
}

/**
 * The runtime's buffered turn, shaped like its real output: many model steps,
 * each with reasoning, a tool call whose input streams in, a tool result,
 * per-step usage frames, and the transient `data-turn-seq` heartbeat; then one
 * long markdown answer that is still being written (no `text-end`, no
 * `finish`).
 */
export function liveTurnReplay({ stepFrames, answerLines }: LiveTurnReplayOptions): {
  body: string
  lastSeq: number
} {
  const frames: string[] = []
  let seq = 0
  const push = (event: Record<string, unknown>) => {
    frames.push(sseFrame(event))
    seq++
    if (seq % 20 === 0) {
      frames.push(sseFrame({ type: "data-turn-seq", data: { turnId: TURN_ID, seq }, transient: true }))
      seq++
    }
  }
  push({ type: "start", messageId: "msg_live" })
  push({ type: "data-turn-start", data: { turnId: TURN_ID, startedAt: Date.now() } })
  for (let step = 0; frames.length < stepFrames; step++) {
    push({ type: "start-step" })
    push({ type: "reasoning-start", id: `r${step}` })
    for (let i = 0; i < 30; i++) push({ type: "reasoning-delta", id: `r${step}`, delta: `step ${step} thought ${i} ` })
    push({ type: "reasoning-end", id: `r${step}` })
    const call = `call_${step}`
    push({ type: "tool-input-start", toolCallId: call, toolName: "edit_file" })
    for (let i = 0; i < 20; i++) push({ type: "tool-input-delta", toolCallId: call, inputTextDelta: `{"line":${i}}` })
    push({ type: "tool-input-available", toolCallId: call, toolName: "edit_file", input: { path: `src/file${step}.tsx` } })
    push({ type: "tool-output-available", toolCallId: call, output: `edited src/file${step}.tsx` })
    push({ type: "text-start", id: `t${step}` })
    for (let i = 0; i < 40; i++) push({ type: "text-delta", id: `t${step}`, delta: `s${step}w${i} ` })
    push({ type: "text-end", id: `t${step}` })
    push({ type: "data-usage", data: { inputTokens: 1000 + step, outputTokens: 50, contextWindowTokens: 200_000, estimatedContextTokens: 1000 + step } })
    push({ type: "data-context-usage", data: { inputTokens: 1000 + step, contextWindowTokens: 200_000 } })
    push({ type: "finish-step" })
  }
  // Streamdown re-parses a text part as it grows, so the answer's render cost
  // grows with the replay.
  push({ type: "start-step" })
  push({ type: "text-start", id: "t_tail" })
  for (let i = 0; i < answerLines; i++) {
    const line =
      i % 25 === 0
        ? `\n\n## Section ${i / 25}\n\n`
        : i % 25 === 10
          ? "\n```ts\nexport const value = compute(" + i + ")\n```\n"
          : `- item ${i} with **bold** and \`code\` text\n`
    for (const token of line.match(/.{1,6}/gs) ?? []) push({ type: "text-delta", id: "t_tail", delta: token })
  }
  push({ type: "text-delta", id: "t_tail", delta: `\n\n${REPLAY_TAIL}` })
  return { body: frames.join(""), lastSeq: seq }
}

/** The replay as the runtime serves it by default: compacted, then the exact seq. */
export function compactedReplay(replay: { body: string; lastSeq: number }): { body: string; lastSeq: number } {
  const decoder = new TextDecoder()
  const compacted = compactSseFrames([new TextEncoder().encode(replay.body)])
  return {
    body: decoder.decode(compacted) + decoder.decode(encodeTurnSeqFrame(TURN_ID, replay.lastSeq)),
    lastSeq: replay.lastSeq,
  }
}

export interface LiveTurnMocks {
  /** Flip once the bootstrap turn is on screen: from then on the turn is live. */
  goLive(): void
  /** Full `/stream` replays served (no `fromSeq`, or `fromSeq=0`). */
  fullReplays(): number
}

export async function installLiveTurnMocks(page: Page, replay: { body: string; lastSeq: number }): Promise<LiveTurnMocks> {
  let live = false
  let fullReplays = 0

  await page.route(CHAT_POST_GLOB, async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurn("Bootstrap done."),
    })
  })

  await page.route(TURN_GLOB, async (route: Route) => {
    if (!live) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ status: "unknown" }) })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "active", turnId: TURN_ID, lastSeq: replay.lastSeq }),
    })
  })

  await page.route(STREAM_GLOB, async (route: Route) => {
    if (!live) {
      await route.fulfill({ status: 204, body: "" })
      return
    }
    const fromSeq = Number(new URL(route.request().url()).searchParams.get("fromSeq") || 0)
    if (fromSeq > 0) {
      // The fulfilled replay body closes; the real `/stream` stays open while
      // the agent works. The client reconnects with `fromSeq`, so hold that
      // request open with nothing new to send, as the live tail would.
      await new Promise((resolve) => setTimeout(resolve, HELD_STREAM_MS))
      await route.fulfill({ status: 204, body: "" }).catch(() => {})
      return
    }
    fullReplays++
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        "X-Turn-Id": TURN_ID,
        "X-Turn-Status": "active",
        // As the API sets it; without it a cross-origin client can't read X-Turn-Id.
        "Access-Control-Expose-Headers": "X-Turn-Id, X-Last-Seq, X-Turn-Status",
      },
      body: replay.body,
    })
  })

  return {
    goLive: () => {
      live = true
    },
    fullReplays: () => fullReplays,
  }
}

/** Crash signals the chat panel logs before its error boundary remounts it. */
export function collectChatCrashes(page: Page): string[] {
  const crashes: string[] = []
  page.on("console", (msg) => {
    const text = msg.text()
    if (/\[PanelErrorBoundary:|Maximum update depth exceeded|Minified React error #185/.test(text)) {
      crashes.push(text.slice(0, 300))
    }
  })
  page.on("pageerror", (err) => {
    if (/Maximum update depth exceeded|Minified React error #185/.test(err.message)) crashes.push(err.message.slice(0, 300))
  })
  return crashes
}

/** Emulate a slower CPU (Chrome only); 1 is a no-op. */
export async function throttleCpu(page: Page, rate: number): Promise<void> {
  if (rate <= 1) return
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate })
}

/**
 * Reload the project (the user coming back mid-turn) and require the live turn
 * to render within `budgetMs`, with no crash, no error screen and exactly one
 * full replay — a second one means the panel remounted and started over.
 */
export async function expectLiveTurnRendersAfterReopen(
  page: Page,
  mocks: LiveTurnMocks,
  crashes: string[],
  budgetMs: number,
): Promise<void> {
  mocks.goLive()
  await page.reload()

  const errorScreen = page.getByText("Chat encountered an error")
  const recovering = page.getByText("Recovering Chat...")
  const tail = page.getByText(REPLAY_TAIL, { exact: false })

  const reopenedAt = Date.now()
  let sawError = false
  let tailVisible = false
  while (Date.now() < reopenedAt + budgetMs) {
    if ((await errorScreen.isVisible().catch(() => false)) || (await recovering.isVisible().catch(() => false))) {
      sawError = true
      break
    }
    if (await tail.isVisible().catch(() => false)) {
      tailVisible = true
      break
    }
    await page.waitForTimeout(250)
  }
  const elapsedMs = Date.now() - reopenedAt
  console.log(
    `[live-turn-replay] fullReplays=${mocks.fullReplays()} tailVisible=${tailVisible} sawError=${sawError} elapsedMs=${elapsedMs}`,
  )

  expect(crashes, `chat panel render crashes:\n${crashes.join("\n")}`).toEqual([])
  expect(sawError, "chat panel showed its error/recovering screen").toBe(false)
  expect(tailVisible, `the live turn did not render within ${budgetMs}ms of reopening`).toBe(true)
  // Give a remount loop time to show itself before counting replays.
  await page.waitForTimeout(3_000)
  expect(crashes, `chat panel render crashes:\n${crashes.join("\n")}`).toEqual([])
  expect(mocks.fullReplays(), "the panel replayed the turn more than once (remount loop)").toBe(1)
}

/**
 * Reload mid-turn and measure, in the page, how long after the `/stream`
 * response arrived the live turn's latest words were on screen.
 */
export async function measureLiveTurnReopen(
  page: Page,
  mocks: LiveTurnMocks,
): Promise<{ streamToRenderMs: number; reloadToRenderMs: number; domNodesAtRender: number }> {
  await page.addInitScript((tail) => {
    const w = window as unknown as { __tailRenderedAt?: number; __tailDomNodes?: number }
    const check = () => {
      if (document.body?.textContent?.includes(tail)) {
        w.__tailRenderedAt = performance.now()
        w.__tailDomNodes = document.getElementsByTagName("*").length
      } else requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  }, REPLAY_TAIL)
  mocks.goLive()
  await page.reload()
  await page.waitForFunction(() => (window as any).__tailRenderedAt !== undefined, null, { timeout: 30_000 })
  return page.evaluate(() => {
    const renderedAt = (window as any).__tailRenderedAt as number
    const stream = performance
      .getEntriesByType("resource")
      .find((e) => /\/chat\/[^/]+\/stream(\?|$)/.test(e.name) && !/fromSeq=[1-9]/.test(e.name)) as
      | PerformanceResourceTiming
      | undefined
    if (!stream) throw new Error("no /stream request in resource timing")
    return {
      streamToRenderMs: Math.round(renderedAt - stream.responseEnd),
      reloadToRenderMs: Math.round(renderedAt),
      domNodesAtRender: (window as any).__tailDomNodes as number,
    }
  })
}
