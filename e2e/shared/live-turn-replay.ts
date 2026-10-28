// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, type Page, type Route } from "@playwright/test"
import { compactSseFrames, encodeTurnSeqFrame } from "../../packages/core/src/stream-compaction"
import { buildSnapshotReplay } from "../../packages/agent-runtime/src/stream-snapshot"

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
/** In the first step's text, so a snapshot replay carries it inside the snapshot. */
export const REPLAY_HEAD = "replay-head-marker"
/**
 * First words of the running sub-agent's output, so the card's one-line
 * activity label carries it: the card shows a summary, not the sub-agent's
 * transcript.
 */
export const SUBAGENT_LIVE_MARKER = "subagent-live-marker"
const TURN_ID = "turn_live"
const HELD_STREAM_MS = 90_000

export interface LiveTurnReplayOptions {
  /** Frames for the work steps (reasoning, tool calls, usage). */
  stepFrames: number
  /** Lines of the answer the turn has written, streamed a few characters at a time. */
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
 * The runtime's buffered turn, shaped like its real output: one `start-step`
 * for the whole turn (the gateway writes one when the turn begins and one
 * `finish-step` when it ends, so nothing closes a step mid-turn), then many
 * closed work parts — reasoning, a tool call whose input streams in, its result,
 * per-step usage frames and the transient `data-turn-seq` heartbeat — then the
 * answer the turn has written (ending with `REPLAY_TAIL`). Every tool frame
 * carries `dynamic: true`, as the gateway writes it: the app only renders
 * `dynamic-tool` parts, so a frame without it draws nothing. It ends with an
 * `agent_spawn` whose sub-agent is still running: its progress arrives as
 * `preliminary: true` outputs, each carrying the whole accumulated state, so the
 * last one is the sub-agent's current text (starting with
 * `SUBAGENT_LIVE_MARKER`).
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
  // No `start` frame: `buffered-turn.ts` never writes one, so a snapshot of a
  // real turn has no message id from the stream (the 2.4.1 regression).
  push({ type: "data-turn-start", data: { turnId: TURN_ID, startedAt: Date.now() } })
  push({ type: "start-step" })
  for (let step = 0; frames.length < stepFrames; step++) {
    push({ type: "reasoning-start", id: `r${step}` })
    for (let i = 0; i < 30; i++) push({ type: "reasoning-delta", id: `r${step}`, delta: `step ${step} thought ${i} ` })
    push({ type: "reasoning-end", id: `r${step}` })
    const call = `call_${step}`
    push({ type: "tool-input-start", toolCallId: call, toolName: "edit_file", dynamic: true })
    for (let i = 0; i < 20; i++) push({ type: "tool-input-delta", toolCallId: call, inputTextDelta: `{"line":${i}}` })
    push({ type: "tool-input-available", toolCallId: call, toolName: "edit_file", input: { path: `src/file${step}.tsx` }, dynamic: true })
    push({ type: "tool-output-available", toolCallId: call, output: `edited src/file${step}.tsx`, dynamic: true })
    push({ type: "text-start", id: `t${step}` })
    if (step === 0) push({ type: "text-delta", id: "t0", delta: `${REPLAY_HEAD} ` })
    for (let i = 0; i < 40; i++) push({ type: "text-delta", id: `t${step}`, delta: `s${step}w${i} ` })
    push({ type: "text-end", id: `t${step}` })
    push({ type: "data-usage", data: { inputTokens: 1000 + step, outputTokens: 50, contextWindowTokens: 200_000, estimatedContextTokens: 1000 + step } })
    push({ type: "data-context-usage", data: { inputTokens: 1000 + step, contextWindowTokens: 200_000 } })
  }

  // The answer the turn has written so far, closed. Streamdown re-parses a text
  // part as it grows, so the snapshot's render cost grows with it.
  push({ type: "text-start", id: "t_answer" })
  for (let i = 0; i < answerLines; i++) {
    const line =
      i % 25 === 0
        ? `\n\n## Section ${i / 25}\n\n`
        : i % 25 === 10
          ? "\n```ts\nexport const value = compute(" + i + ")\n```\n"
          : `- item ${i} with **bold** and \`code\` text\n`
    for (const token of line.match(/.{1,6}/gs) ?? []) {
      push({ type: "text-delta", id: "t_answer", delta: token })
    }
  }
  push({ type: "text-delta", id: "t_answer", delta: `\n\n${REPLAY_TAIL}` })
  push({ type: "text-end", id: "t_answer" })

  // The sub-agent the user watched replay: still running, so its call stays
  // open and each update repeats everything it has written so far. Its text
  // starts with SUBAGENT_LIVE_MARKER, which is what the card's activity line
  // shows — the card summarises the run, it does not print its transcript.
  const spawn = "call_spawn"
  push({ type: "tool-input-start", toolCallId: spawn, toolName: "agent_spawn", dynamic: true })
  push({
    type: "tool-input-available",
    toolCallId: spawn,
    toolName: "agent_spawn",
    input: { type: "browser_qa", description: "check the app" },
    dynamic: true,
  })
  const update = (text: string) =>
    push({
      type: "tool-output-available",
      toolCallId: spawn,
      output: { agentId: "qa", instance_id: "qa-1", model: "sonnet", parts: [{ type: "text", text, id: "sa-text-0" }] },
      dynamic: true,
      preliminary: true,
    })

  const subagent = [`${SUBAGENT_LIVE_MARKER} checking the canvas `]
  for (let i = 0; i < Math.max(1, Math.round(answerLines / 4)); i++) subagent.push(`step ${i} `)
  const tokens = subagent.join("").match(/.{1,6}/gs) ?? []
  const updates = Math.max(1, Math.min(60, Math.ceil(tokens.length / 8)))
  const perUpdate = Math.ceil(tokens.length / updates)
  let written = ""
  for (let i = 0; i < tokens.length; i++) {
    written += tokens[i]
    if ((i + 1) % perUpdate === 0 || i === tokens.length - 1) update(written)
  }
  return { body: frames.join(""), lastSeq: seq }
}

/** How many sub-agent updates a served replay body carries. */
export function countPreliminaryOutputs(body: string): number {
  return body
    .split("\n\n")
    .filter((event) => {
      if (!event.startsWith("data: {")) return false
      try {
        return JSON.parse(event.slice(6)).preliminary === true
      } catch {
        return false
      }
    }).length
}

/** The replay as the runtime serves it by default: compacted, then the exact seq. */
export function compactedReplay(replay: { body: string; lastSeq: number }): { body: string; lastSeq: number } {
  return { body: compactedReplayBody(replay), lastSeq: replay.lastSeq }
}

function compactedReplayBody(replay: { body: string; lastSeq: number }): string {
  const decoder = new TextDecoder()
  const compacted = compactSseFrames([new TextEncoder().encode(replay.body)])
  return decoder.decode(compacted) + decoder.decode(encodeTurnSeqFrame(TURN_ID, replay.lastSeq))
}

/**
 * What the runtime serves a client that asks for `?snapshot=1`: the message up
 * to the last point where no part is open in one chunk, the part that is still
 * open (a running sub-agent, for the live turn above), then the exact seq.
 */
export async function snapshotReplay(replay: { body: string; lastSeq: number }): Promise<{ body: string; lastSeq: number }> {
  const decoder = new TextDecoder()
  const snapshot = await buildSnapshotReplay([new TextEncoder().encode(replay.body)])
  return {
    body: decoder.decode(snapshot) + decoder.decode(encodeTurnSeqFrame(TURN_ID, replay.lastSeq)),
    lastSeq: replay.lastSeq,
  }
}

export interface LiveTurnMocksOptions {
  /**
   * Whether the mocked runtime understands `?snapshot=1`. `false` plays a
   * runtime that predates it and replays the (compacted) buffer instead.
   */
  snapshot?: boolean
}

export interface LiveTurnMocks {
  /** Flip once the bootstrap turn is on screen: from then on the turn is live. */
  goLive(): void
  /** Full `/stream` replays served (no `fromSeq`, or `fromSeq=0`). */
  fullReplays(): number
  /** Of those, how many asked for `?snapshot=1` and were answered with one. */
  snapshotReplays(): number
  /** Of those, how many asked for `?snapshot=1`, whether or not it was honored. */
  snapshotRequests(): number
  /**
   * Sub-agent updates (`preliminary: true` tool outputs) in the snapshot the
   * runtime served — 1 means the client got the sub-agent's current state, not
   * its whole update history.
   */
  snapshotSubagentUpdates(): number
}

export async function installLiveTurnMocks(
  page: Page,
  replay: { body: string; lastSeq: number },
  { snapshot = true }: LiveTurnMocksOptions = {},
): Promise<LiveTurnMocks> {
  let live = false
  let fullReplays = 0
  let snapshotReplays = 0
  let snapshotRequests = 0
  const snapshotBody = snapshot ? (await snapshotReplay(replay)).body : null
  const snapshotUpdates = snapshotBody ? countPreliminaryOutputs(snapshotBody) : 0
  // A runtime that predates snapshots replays the compacted buffer.
  const plainBody = snapshot ? null : compactedReplayBody(replay)

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
    const wantsSnapshot = new URL(route.request().url()).searchParams.get("snapshot") === "1"
    if (wantsSnapshot) snapshotRequests++
    const body = wantsSnapshot && snapshotBody ? snapshotBody : (plainBody ?? replay.body)
    if (wantsSnapshot && snapshotBody) snapshotReplays++
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
      body,
    })
  })

  return {
    goLive: () => {
      live = true
    },
    fullReplays: () => fullReplays,
    snapshotReplays: () => snapshotReplays,
    snapshotRequests: () => snapshotRequests,
    snapshotSubagentUpdates: () => snapshotUpdates,
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
  await expect(
    page.getByText(REPLAY_HEAD, { exact: false }).first(),
    "the start of the live turn is missing (a snapshot hidden behind the rest of the turn)",
  ).toBeVisible()
  // The running sub-agent came through as its current state, so its card is on
  // screen with its latest activity — not N cards from replaying every update
  // (`snapshotSubagentUpdates()` counts the updates the runtime served).
  await expect(
    page.getByText(SUBAGENT_LIVE_MARKER, { exact: false }).first(),
    "the running sub-agent's card is missing (the snapshot's continuation never landed)",
  ).toBeVisible({ timeout: 10_000 })
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
