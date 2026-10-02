// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop streaming stress test. See ./README.md for how to run it.
 *
 * Runs the real dev desktop app against a scripted fake model and checks that
 * every view shows exactly the tokens the model sent, with bounded lag.
 * Checks are soft so one run reports every problem instead of stopping at the
 * first. Numbers for each scenario land in test-results/streaming-e2e/*.json.
 */
import { expect, test } from '@playwright/test'
import {
  BOGUS_FALLBACKS,
  REPORT_DIR,
  backgroundTurnState,
  chatStreamUrl,
  createChatSession,
  startBackgroundTurn,
  expandWorkedSections,
  launchDesktop,
  leaveChat,
  queuedCount,
  reloadApp,
  returnToChat,
  send,
  settleTokens,
  stopButton,
  waitIdle,
  writeReport,
  type Harness,
} from './desktop-app'
import { marker } from './fake-llm-server'
import {
  arrivalTimes,
  beginProbe,
  checkSequence,
  isCleanPrefix,
  isExactRun,
  pageShows,
  readProbe,
  renderLag,
  renderLags,
  startWireTap,
  stopWireTap,
  summarizeLags,
  visibleTokens,
  type ProbeResult,
} from './stream-probe'

test.skip(process.env.PLAYWRIGHT_E2E !== '1', 'set PLAYWRIGHT_E2E=1 to run')
test.setTimeout(300_000)

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback)

/** Budgets. Override with the SHOGO_E2E_* variables when calibrating a slower machine. */
const BUDGET = {
  firstTokenMs: num('SHOGO_E2E_FIRST_TOKEN_MS', 1500),
  lagP95Ms: num('SHOGO_E2E_LAG_P95_MS', 250),
  lagMaxMs: num('SHOGO_E2E_LAG_MAX_MS', 800),
  longTaskMs: num('SHOGO_E2E_LONG_TASK_MS', 250),
  /** Fake model -> the stream a window reads (runtime + proxy + API). */
  serverLagP95Ms: num('SHOGO_E2E_SERVER_LAG_P95_MS', 150),
  /** Stream arrival -> text on screen (React, markdown, layout). */
  rendererLagP95Ms: num('SHOGO_E2E_RENDERER_LAG_P95_MS', 150),
  chats: num('SHOGO_E2E_CHATS', 5),
  toolCalls: num('SHOGO_E2E_TOOL_CALLS', 60),
  /** How long Stop may take to take effect, both on screen and at the model. */
  stopMs: num('SHOGO_E2E_STOP_MS', 2000),
  /** How far behind the server a window may be right after coming back to it. */
  catchUpMs: num('SHOGO_E2E_CATCH_UP_MS', 1500),
  /** A later turn may lag at most this many times the first turn's p95 (history growth). */
  growthFactor: num('SHOGO_E2E_GROWTH_FACTOR', 2),
  growthTurns: num('SHOGO_E2E_GROWTH_TURNS', 6),
}

let h: Harness

test.beforeAll(async () => {
  test.setTimeout(600_000)
  h = await launchDesktop()
})

test.afterAll(async () => {
  await h?.close()
})

test.afterEach(async ({}, info) => {
  // React's "Maximum update depth exceeded" is the signature of a render loop.
  const loops = h.rendererErrors.filter((e) => e.includes('Maximum update depth exceeded'))
  expect.soft(loops, `render loop in "${info.title}"`).toEqual([])
})

/** Streams `tag` to completion and returns what the window showed. */
async function streamToEnd(tag: string, text: string, total: number, timeoutMs = 120_000) {
  await beginProbe(h.page, tag)
  await send(h.page, text)
  await h.llm.waitForTokens(tag, total, timeoutMs)
  await waitIdle(h.page, 60_000)
  return finish(tag)
}

async function finish(tag: string) {
  const probe = await readProbe(h.page)
  const settled = await settleTokens(h.page, tag)
  return { probe, sequence: settled.sequence, settledAfterMs: settled.settledAfterMs }
}

function checkLag(name: string, tag: string, probe: ProbeResult, budget = BUDGET) {
  const lag = renderLag({ sentAt: h.llm.sentAt(tag) }, probe.samples)
  expect.soft(lag.firstTokenMs ?? Infinity, `${name}: first token`).toBeLessThanOrEqual(budget.firstTokenMs)
  expect.soft(lag.p95Ms, `${name}: p95 render lag`).toBeLessThanOrEqual(budget.lagP95Ms)
  expect.soft(lag.maxMs, `${name}: worst render lag`).toBeLessThanOrEqual(budget.lagMaxMs)
  expect.soft(probe.longTasks.maxMs, `${name}: longest UI stall`).toBeLessThanOrEqual(budget.longTaskMs)
  return lag
}


/**
 * Splits lag into the server side (fake model -> stream) and the renderer side
 * (stream -> screen), using a second reader on the same stream the window uses.
 */
async function stageLags(tag: string, total: number, probe: ProbeResult) {
  const wire = await stopWireTap(h.page)
  const sent = h.llm.sentAt(tag)
  // fake model -> a second reader on the resume stream
  const server = renderLag({ sentAt: sent }, wire.samples)
  // fake model -> the window's own response stream
  const transport = renderLag({ sentAt: sent }, probe.own)
  // the window's own response stream -> text on screen
  const ownArrivals = arrivalTimes(probe.own, total)
  const render = summarizeLags(renderLags({ sentAt: ownArrivals }, probe.samples).lags)
  return { server, transport, render, renderer: render, wireStatus: wire.status, wireError: wire.error }
}

async function tapStream(tag: string, sessionId = h.sessionId) {
  await h.llm.waitForTurn(tag, 60_000)
  await startWireTap(h.page, chatStreamUrl(h, sessionId), tag)
}

/** Largest number of duplicated tokens ever on screen at once during the run. */
function worstDuplication(probe: ProbeResult): number {
  return probe.samples.reduce((worst, s) => Math.max(worst, s.total - s.distinct), 0)
}

async function expectNoFallback(where: string) {
  for (const text of BOGUS_FALLBACKS) {
    expect.soft(await pageShows(h.page, text), `${where}: shows "${text}"`).toBe(false)
  }
}

/** Polls until `cond` holds, returning how long it took, or null on timeout. */
async function timeUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<number | null> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await cond()) return Date.now() - started
    await new Promise((r) => setTimeout(r, 25))
  }
  return null
}

// ── Streaming basics ───────────────────────────────────────────────────────

test('baseline long stream', async () => {
  const tag = 'b1'
  const total = 2000
  await beginProbe(h.page, tag)
  await send(h.page, `${marker('long', tag, total)} go`)
  await tapStream(tag)
  await h.llm.waitForTokens(tag, total, 120_000)
  await waitIdle(h.page, 60_000)
  const { probe, sequence, settledAfterMs } = await finish(tag)
  const stages = await stageLags(tag, total, probe)
  const lag = checkLag('baseline', tag, probe)
  const seq = checkSequence(sequence)
  writeReport('baseline', { lag, stages, seq: { ...seq, gaps: seq.gaps.length }, settledAfterMs, longTasks: probe.longTasks, frames: probe.frames, probeCostMs: probe.sampleCostMaxMs })

  expect.soft(stages.server.p95Ms, 'p95 lag on the server side (model -> stream)').toBeLessThanOrEqual(BUDGET.serverLagP95Ms)
  expect.soft(stages.transport.p95Ms, "p95 lag until the window's own response stream delivers a token").toBeLessThanOrEqual(BUDGET.serverLagP95Ms)
  expect.soft(stages.render.p95Ms, 'p95 lag from delivery to text on screen').toBeLessThanOrEqual(BUDGET.rendererLagP95Ms)
  expect.soft(isExactRun(sequence, total), `final text: ${JSON.stringify({ ...seq, gaps: seq.gaps.length })}`).toBe(true)
  expect.soft(worstDuplication(probe), 'duplicated tokens on screen while streaming').toBe(0)
})

test('tool-call turn', async () => {
  const tag = 'tc1'
  const total = 600
  await beginProbe(h.page, tag)
  await send(h.page, `${marker('tool', tag, total, { rounds: 2 })} go`)
  await h.llm.waitForTokens(tag, total, 120_000)
  await waitIdle(h.page, 60_000)

  const probe = await readProbe(h.page)
  const settled = await settleTokens(h.page, tag)
  const lag = checkLag('tool-call', tag, probe)
  // Finished turns fold earlier text into "Worked for ..." sections.
  const sections = await expandWorkedSections(h.page, tag)
  const sequence = await visibleTokens(h.page, tag)
  const seq = checkSequence(sequence)
  const requests = h.llm.requestsFor(tag).map((t) => ({ round: t.round, tool: t.toolCalled, tokens: t.sentAt.length }))
  writeReport('tool-call', { requests, sections, lag, seq: { ...seq, gaps: seq.gaps.length }, settledAfterIdleMs: settled.settledAfterMs, longTasks: probe.longTasks })

  expect.soft(requests.map((r) => r.tool), 'tool called after rounds 0 and 1').toEqual(['read_file', 'read_file', undefined])
  expect.soft(isExactRun(sequence, total), `final text: ${JSON.stringify({ ...seq, gaps: seq.gaps.length })}`).toBe(true)
  expect.soft(worstDuplication(probe), 'duplicated tokens on screen while streaming').toBe(0)
  // The Stop button went away before the reply was fully on screen.
  expect.soft(settled.settledAfterMs, 'ms the reply kept growing after the turn showed as finished').toBeLessThanOrEqual(300)
})

// ── Queued messages ────────────────────────────────────────────────────────

async function runQueueScenario(name: string, lead: string, leadKind: 'hold' | 'long') {
  const leadTokens = 120
  const queued = [1, 2, 3].map((i) => `${lead}${i}`)
  await beginProbe(h.page, lead)
  await send(h.page, `${marker(leadKind, lead, leadTokens, { ms: 40 })} lead`)
  await h.llm.waitForTurn(lead, 60_000)
  await expect(stopButton(h.page)).toBeVisible()

  for (const tag of queued) await send(h.page, `${marker('long', tag, 80)} queued ${tag}`)
  const shown = await timeUntil(async () => (await queuedCount(h.page)) === queued.length, 8_000)
  expect.soft(shown, `queue panel never showed ${queued.length} queued messages (shows ${await queuedCount(h.page)})`).not.toBeNull()

  const releasedAt = Date.now()
  if (leadKind === 'hold') h.llm.release(lead)
  for (const tag of queued) await h.llm.waitForTokens(tag, 80, 120_000)
  await waitIdle(h.page, 60_000)
  await h.page.waitForTimeout(1000)

  const all = [lead, ...queued]
  const dispatched = h.llm.turns.filter((t) => all.includes(t.tag) && t.round === 0).sort((a, b) => a.startedAt - b.startedAt)
  expect.soft(dispatched.map((t) => t.tag), 'model saw messages in this order, once each').toEqual(all)
  const requestCounts = Object.fromEntries(all.map((t) => [t, h.llm.requestsFor(t).length]))
  expect.soft(requestCounts, 'requests per message').toEqual(Object.fromEntries(all.map((t) => [t, 1])))

  await h.page.screenshot({ path: `${REPORT_DIR}/${name}.png` })
  const outline = await pageOutline()
  const queueRows = await h.page.getByLabel('Queued message', { exact: true }).allInnerTexts()
  const live = await checkAllReplies(all, lead, leadTokens, 'live')
  expect.soft(await queuedCount(h.page), 'queue is empty at the end').toBe(0)
  expect.soft(await stopButton(h.page).count(), 'stop button gone at the end').toBe(0)

  // What the server saved, as a freshly loaded window sees it.
  await reloadApp(h.page)
  await h.page.waitForTimeout(1500)
  const outlineAfterReload = await pageOutline()
  const reloaded = await checkAllReplies(all, lead, leadTokens, 'after reload')

  const wire = h.llm.turns.map((t) => ({ tag: t.tag, startedAfterReleaseMs: t.startedAt - releasedAt, sent: t.sentAt.length, hungUpByApp: t.clientClosedAt !== undefined }))
  writeReport(name, { outline, outlineAfterReload, wire, queueRows, shownAfterMs: shown, dispatched: dispatched.map((t) => t.tag), requestCounts, live, reloaded })
}

/** The page's text with each run of numbered tokens collapsed to one line. */
async function pageOutline(): Promise<string[]> {
  return h.page.evaluate(() =>
    document.body.innerText
      .replace(/(?:\bt[a-z0-9]+w\d{4}\s*)+/g, (run) => {
        const t = run.trim().split(/\s+/)
        return `<${t.length} tokens ${t[0]}..${t[t.length - 1]}>`
      })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  )
}

/** Every message must be in the transcript with its own full reply. */
async function checkAllReplies(all: string[], lead: string, leadTokens: number, where: string) {
  const out: Record<string, { userMessage: boolean; reply: ReturnType<typeof checkSequence>; exact: boolean }> = {}
  for (const tag of all) {
    const seq = await visibleTokens(h.page, tag)
    const reply = checkSequence(seq)
    const exact = isExactRun(seq, tag === lead ? leadTokens : 80)
    const userMessage = await pageShows(h.page, tag === lead ? ' lead' : `queued ${tag}`)
    out[tag] = { userMessage, reply: { ...reply, gaps: reply.gaps.length } as any, exact }
    expect.soft(userMessage, `${where}: the message for ${tag} is in the transcript`).toBe(true)
    expect.soft(exact, `${where}: reply to ${tag} is complete: ${JSON.stringify({ ...reply, gaps: reply.gaps.length })}`).toBe(true)
  }
  return out
}

test('queued messages sent while the model is streaming run once each, in order', () => runQueueScenario('queue-while-streaming', 'qs', 'long'))

test('queued messages sent while the model is thinking run once each, in order', () => runQueueScenario('queue-while-thinking', 'qh', 'hold'))

// ── Stop ───────────────────────────────────────────────────────────────────

async function stopAndMeasure(tag: string) {
  const clickedAt = Date.now()
  await stopButton(h.page).click()
  const goneMs = await timeUntil(async () => (await stopButton(h.page).count()) === 0, BUDGET.stopMs * 3)
  const cancelledMs = await timeUntil(() => h.llm.wasCancelled(tag), BUDGET.stopMs * 3)
  return { goneMs, cancelledMs, clickedAt }
}

test('stop mid-text, then reload and keep chatting', async () => {
  const tag = 's1'
  await beginProbe(h.page, tag)
  await send(h.page, `${marker('long', tag, 2000)} go`)
  await h.llm.waitForTokens(tag, 300, 60_000)
  const { goneMs, cancelledMs } = await stopAndMeasure(tag)
  const stopped = await settleTokens(h.page, tag)
  const seq = checkSequence(stopped.sequence)

  expect.soft(goneMs, 'Stop button still showing').not.toBeNull()
  expect.soft(goneMs ?? Infinity, 'ms until the Stop button went away').toBeLessThanOrEqual(BUDGET.stopMs)
  expect.soft(cancelledMs, 'the model request was never cancelled').not.toBeNull()
  expect.soft(cancelledMs ?? Infinity, 'ms until the model request was cancelled').toBeLessThanOrEqual(BUDGET.stopMs)
  expect.soft(isCleanPrefix(stopped.sequence) && stopped.sequence.length > 0, `text after stop is a clean prefix: ${JSON.stringify({ ...seq, gaps: seq.gaps.length })}`).toBe(true)
  expect.soft(h.llm.sentAt(tag).length, 'model kept streaming after Stop').toBeLessThan(2000)
  await expectNoFallback('after stop (live)')

  await reloadApp(h.page)
  const reloaded = await settleTokens(h.page, tag)
  expect.soft(isCleanPrefix(reloaded.sequence), 'saved text after reload is a clean prefix').toBe(true)
  // The live view may trail the server by a few tokens, but it must not drop what was already saved.
  expect.soft(reloaded.sequence.length - stopped.sequence.length, 'tokens the saved reply has beyond what the live view showed after Stop').toBeLessThanOrEqual(10)
  await expectNoFallback('after stop (reloaded)')
  await expect(stopButton(h.page)).toHaveCount(0)

  const next = await streamToEnd('s1b', `${marker('long', 's1b', 100)} next`, 100)
  expect.soft(isExactRun(next.sequence, 100), 'a new message after Stop streams normally').toBe(true)
  writeReport('stop-mid-text', { goneMs, cancelledMs, shownAtStop: stopped.sequence.length, sentAtStop: h.llm.sentAt(tag).length, reloaded: reloaded.sequence.length })
})

test('stop before any text arrives', async () => {
  const tag = 's2'
  await send(h.page, `${marker('hold', tag, 50)} go`)
  await h.llm.waitForTurn(tag, 60_000)
  await expect(stopButton(h.page)).toBeVisible()
  const { goneMs, cancelledMs } = await stopAndMeasure(tag)

  expect.soft(goneMs ?? Infinity, 'ms until the Stop button went away').toBeLessThanOrEqual(BUDGET.stopMs)
  expect.soft(cancelledMs ?? Infinity, 'ms until the model request was cancelled').toBeLessThanOrEqual(BUDGET.stopMs)
  await h.page.waitForTimeout(1000)
  await expectNoFallback('stopped before any text (live)')

  await reloadApp(h.page)
  await h.page.waitForTimeout(1000)
  await expectNoFallback('stopped before any text (reloaded)')

  const next = await streamToEnd('s2b', `${marker('long', 's2b', 100)} next`, 100)
  expect.soft(isExactRun(next.sequence, 100), 'a new message after Stop streams normally').toBe(true)
  writeReport('stop-before-text', { goneMs, cancelledMs })
})

test('stop between a tool call and its follow-up', async () => {
  const tag = 's3'
  await beginProbe(h.page, tag)
  // Round 0 streams text and calls a tool; round 1 (the follow-up) is held.
  await send(h.page, `${marker('tool', tag, 200, { rounds: 1, holdAt: 1 })} go`)
  await h.llm.waitForRequestCount(tag, 2, 60_000)
  await expect(stopButton(h.page)).toBeVisible()
  const { goneMs, cancelledMs } = await stopAndMeasure(tag)
  await h.page.waitForTimeout(1000)

  expect.soft(goneMs ?? Infinity, 'ms until the Stop button went away').toBeLessThanOrEqual(BUDGET.stopMs)
  expect.soft(cancelledMs ?? Infinity, 'ms until the follow-up request was cancelled').toBeLessThanOrEqual(BUDGET.stopMs)
  await expectNoFallback('stopped after a tool call (live)')
  const kept = await settleTokens(h.page, tag)
  expect.soft(isCleanPrefix(kept.sequence), 'text before the tool call is kept, as a clean prefix').toBe(true)

  await reloadApp(h.page)
  await h.page.waitForTimeout(1000)
  await expectNoFallback('stopped after a tool call (reloaded)')
  writeReport('stop-after-tool', { goneMs, cancelledMs, kept: kept.sequence.length })
})

// ── Leaving and coming back ────────────────────────────────────────────────

test('leave the chat mid-stream and come back', async () => {
  const tag = 'l1'
  const total = 1500
  await beginProbe(h.page, tag)
  await send(h.page, `${marker('long', tag, total)} go`)
  await h.llm.waitForTokens(tag, 400, 60_000)
  await leaveChat(h.page)
  await h.page.waitForTimeout(3000)
  const sentWhileAway = h.llm.sentAt(tag).length
  await returnToChat(h.page)
  await beginProbe(h.page, tag)

  const caughtUpMs = await timeUntil(async () => {
    const seq = await visibleTokens(h.page, tag)
    return seq.length > 0 && Math.max(...seq) >= h.llm.sentAt(tag).length - 25
  }, 15_000)
  expect.soft(caughtUpMs, 'window never caught up with the stream after coming back').not.toBeNull()
  expect.soft(caughtUpMs ?? Infinity, 'ms to catch up after coming back').toBeLessThanOrEqual(BUDGET.catchUpMs)

  await h.llm.waitForTokens(tag, total, 60_000)
  await waitIdle(h.page, 60_000)
  const { probe, sequence } = await finish(tag)
  const seq = checkSequence(sequence)
  expect.soft(isExactRun(sequence, total), `after returning: ${JSON.stringify({ ...seq, gaps: seq.gaps.length })}`).toBe(true)
  expect.soft(worstDuplication(probe), 'duplicated tokens on screen after returning').toBe(0)
  writeReport('leave-and-return', { sentWhileAway, caughtUpMs, seq: { ...seq, gaps: seq.gaps.length }, longTasks: probe.longTasks })
})

test('leave the chat, let the turn finish, come back', async () => {
  const tag = 'l2'
  const total = 300
  await beginProbe(h.page, tag)
  await send(h.page, `${marker('long', tag, total)} go`)
  await h.llm.waitForTokens(tag, 50, 60_000)
  await leaveChat(h.page)
  await h.llm.waitForTokens(tag, total, 60_000)
  await h.page.waitForTimeout(2000)
  await returnToChat(h.page)

  const { sequence } = await finish(tag)
  const seq = checkSequence(sequence)
  expect.soft(isExactRun(sequence, total), `reply that finished while away: ${JSON.stringify({ ...seq, gaps: seq.gaps.length })}`).toBe(true)
  expect.soft(await stopButton(h.page).count(), 'chat still shows as streaming').toBe(0)
  writeReport('leave-finished', { seq: { ...seq, gaps: seq.gaps.length } })
})

test('reload mid-stream', async () => {
  const tag = 'r1'
  const total = 1500
  await send(h.page, `${marker('long', tag, total)} go`)
  await h.llm.waitForTokens(tag, 400, 60_000)
  await reloadApp(h.page)
  await beginProbe(h.page, tag)

  const caughtUpMs = await timeUntil(async () => {
    const seq = await visibleTokens(h.page, tag)
    return seq.length > 0 && Math.max(...seq) >= h.llm.sentAt(tag).length - 25
  }, 20_000)
  expect.soft(caughtUpMs, 'window never caught up with the stream after a reload').not.toBeNull()

  await h.llm.waitForTokens(tag, total, 60_000)
  await waitIdle(h.page, 60_000)
  const { probe, sequence } = await finish(tag)
  const seq = checkSequence(sequence)
  expect.soft(isExactRun(sequence, total), `after reload: ${JSON.stringify({ ...seq, gaps: seq.gaps.length })}`).toBe(true)
  expect.soft(worstDuplication(probe), 'duplicated tokens on screen after reload').toBe(0)
  writeReport('reload-mid-stream', { caughtUpMs, seq: { ...seq, gaps: seq.gaps.length } })
})

// ── History growth (slowness) ──────────────────────────────────────────────

test('streaming stays fast as the chat grows', async () => {
  const rows: Array<{ turn: number; p95Ms: number; maxMs: number; longTaskMs: number; settledAfterMs: number }> = []
  for (let i = 1; i <= BUDGET.growthTurns; i++) {
    const tag = `g${i}`
    const total = 900
    await beginProbe(h.page, tag)
    await send(h.page, `${marker('tool', tag, total, { rounds: 2, ms: 8 })} go`)
    await h.llm.waitForTokens(tag, total, 120_000)
    await waitIdle(h.page, 60_000)
    const probe = await readProbe(h.page)
    const settled = await settleTokens(h.page, tag)
    const lag = renderLag({ sentAt: h.llm.sentAt(tag) }, probe.samples)
    rows.push({ turn: i, p95Ms: lag.p95Ms, maxMs: lag.maxMs, longTaskMs: probe.longTasks.maxMs, settledAfterMs: settled.settledAfterMs })
    expect.soft(lag.maxMs, `turn ${i}: worst render lag`).toBeLessThanOrEqual(BUDGET.lagMaxMs)
    expect.soft(probe.longTasks.maxMs, `turn ${i}: longest UI stall`).toBeLessThanOrEqual(BUDGET.longTaskMs)
  }
  const first = rows[0].p95Ms
  const last = rows[rows.length - 1].p95Ms
  writeReport('history-growth', { rows, budget: BUDGET })
  expect.soft(last, `p95 lag on turn ${rows.length} vs turn 1 (${first}ms)`).toBeLessThanOrEqual(Math.max(first * BUDGET.growthFactor, BUDGET.lagP95Ms))
})

// ── Real-world load ────────────────────────────────────────────────────────

/** Per-token lag split into thirds of the run, to see whether it grows. */
function lagByThird(tag: string, probe: ProbeResult) {
  const { lags } = renderLags({ sentAt: h.llm.sentAt(tag) }, probe.samples)
  const size = Math.ceil(lags.length / 3)
  return [0, 1, 2].map((i) => {
    const part = summarizeLags(lags.slice(i * size, (i + 1) * size))
    return { p95Ms: part.p95Ms, maxMs: part.maxMs }
  })
}

test('one turn with many tool calls', async () => {
  test.setTimeout(900_000)
  const tag = 'm1'
  const rounds = BUDGET.toolCalls
  const total = rounds * 30
  await beginProbe(h.page, tag)
  await send(h.page, `${marker('tool', tag, total, { rounds })} go`)
  await tapStream(tag)
  await h.llm.waitForTokens(tag, total, 600_000)
  await waitIdle(h.page, 120_000)

  const probe = await readProbe(h.page)
  const settled = await settleTokens(h.page, tag)
  const stages = await stageLags(tag, total, probe)
  const lag = checkLag(`${rounds} tool calls`, tag, probe)
  const thirds = lagByThird(tag, probe)
  const requests = h.llm.requestsFor(tag)
  const sections = await expandWorkedSections(h.page, tag)
  const sequence = await visibleTokens(h.page, tag)
  const seq = checkSequence(sequence)
  const toolsCalled = requests.filter((r) => r.toolCalled).length
  writeReport('many-tool-calls', { rounds, requests: requests.length, toolsCalled, sections, lag, stages, thirds, seq: { ...seq, gaps: seq.gaps.length }, settledAfterIdleMs: settled.settledAfterMs, longTasks: probe.longTasks, frames: probe.frames, probeCostMs: probe.sampleCostMaxMs })

  expect.soft(toolsCalled, 'tool calls the app made').toBe(rounds)
  expect.soft(isExactRun(sequence, total), `final text: ${JSON.stringify({ ...seq, gaps: seq.gaps.length })}`).toBe(true)
  expect.soft(worstDuplication(probe), 'duplicated tokens on screen while streaming').toBe(0)
  expect.soft(thirds[2].p95Ms, `p95 lag in the last third vs the first (${thirds[0].p95Ms}ms)`).toBeLessThanOrEqual(Math.max(thirds[0].p95Ms * BUDGET.growthFactor, BUDGET.lagP95Ms))
  expect.soft(frameStall(probe), 'longest gap between frames').toBeLessThanOrEqual(BUDGET.longTaskMs * 2)
})

function frameStall(probe: ProbeResult): number {
  return probe.frames.maxGapMs
}

test('several chats streaming at once', async () => {
  test.setTimeout(900_000)
  const count = BUDGET.chats
  const background = count - 1
  const bgRounds = 20
  const bgTotal = bgRounds * 60
  const rounds = 20
  const total = rounds * 60

  // Other chats of the project run turns the window doesn't have open, the way a
  // second window or the island would, each reading its stream to the end.
  const bg: Array<{ tag: string; id: string }> = []
  for (let i = 0; i < background; i++) {
    const id = await createChatSession(h.page, h.projectId, `Background ${i + 1}`)
    const tag = `bg${i + 1}`
    const status = await startBackgroundTurn(h.page, h, id, `${marker('tool', tag, bgTotal, { rounds: bgRounds })} background ${i + 1}`, tag)
    expect.soft(status, `background chat ${i + 1}: request accepted`).toBe(200)
    bg.push({ tag, id })
  }
  for (const { tag } of bg) await h.llm.waitForTurn(tag, 60_000)

  // The chat open in the window streams too.
  const tag = 'cv'
  await beginProbe(h.page, tag)
  await send(h.page, `${marker('tool', tag, total, { rounds })} visible`)
  await tapStream(tag)
  const stillStreaming = bg.filter((c) => h.llm.sentAt(c.tag).length < bgTotal).length
  await h.llm.waitForTokens(tag, total, 600_000)
  await waitIdle(h.page, 120_000)
  const probe = await readProbe(h.page)
  const settled = await settleTokens(h.page, tag)
  const stages = await stageLags(tag, total, probe)

  for (const c of bg) await h.llm.waitForTokens(c.tag, bgTotal, 600_000)
  await h.page.waitForTimeout(1500)

  const sections = await expandWorkedSections(h.page, tag)
  const sequence = await visibleTokens(h.page, tag)
  const seq = checkSequence(sequence)
  const lag = renderLag({ sentAt: h.llm.sentAt(tag) }, probe.samples)
  const thirds = lagByThird(tag, probe)

  const others: Array<{ tag: string; status: number; ended: boolean; exact: boolean; repeats: number }> = []
  for (const c of bg) {
    const state = await backgroundTurnState(h.page, c.id)
    const check = checkSequence(state?.tokens ?? [])
    const exact = isExactRun(state?.tokens ?? [], bgTotal)
    // Same response path as a window's, but read by a bare loop with no React behind it.
    const bare = (() => {
      const sent = h.llm.sentAt(c.tag)
      const lags = (state?.times ?? []).map((t, i) => t - (sent[(state?.tokens[i] ?? 1) - 1] ?? t))
      return summarizeLags(lags)
    })()
    others.push({ tag: c.tag, status: state?.status ?? 0, ended: state?.ended ?? false, exact, repeats: check.repeats, bareReaderLag: bare } as any)
    expect.soft(state?.ended, `background chat ${c.tag}: stream ended`).toBe(true)
    expect.soft(exact, `background chat ${c.tag}: its own stream carried every token once, in order (${JSON.stringify({ ...check, gaps: check.gaps.length })})`).toBe(true)
  }
  writeReport('concurrent-chats', { chats: count, stillStreamingWhenOpenChatStarted: stillStreaming, lagOfOpenChat: lag, stages, thirds, sections, seq: { ...seq, gaps: seq.gaps.length }, others, settledAfterIdleMs: settled.settledAfterMs, longTasks: probe.longTasks, frames: probe.frames, probeCostMs: probe.sampleCostMaxMs })

  expect.soft(stillStreaming, 'other chats still streaming when the open chat started').toBe(background)
  expect.soft(isExactRun(sequence, total), `open chat final text: ${JSON.stringify({ ...seq, gaps: seq.gaps.length })}`).toBe(true)
  expect.soft(lag.p95Ms, 'open chat: p95 render lag while other chats stream').toBeLessThanOrEqual(BUDGET.lagP95Ms)
  expect.soft(lag.maxMs, 'open chat: worst render lag while other chats stream').toBeLessThanOrEqual(BUDGET.lagMaxMs)
  expect.soft(probe.longTasks.maxMs, 'open chat: longest UI stall while other chats stream').toBeLessThanOrEqual(BUDGET.longTaskMs)
  expect.soft(stages.server.p95Ms, 'p95 lag on the server side while other chats stream').toBeLessThanOrEqual(BUDGET.serverLagP95Ms)
  expect.soft(stages.transport.p95Ms, "p95 lag until the window's own response stream delivers a token, while other chats stream").toBeLessThanOrEqual(BUDGET.serverLagP95Ms)
  expect.soft(stages.render.p95Ms, 'p95 lag from delivery to text on screen while other chats stream').toBeLessThanOrEqual(BUDGET.rendererLagP95Ms)
})
