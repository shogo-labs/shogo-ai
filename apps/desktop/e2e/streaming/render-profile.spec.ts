// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * React render profile of the chat panel during a long, tool-heavy turn on top
 * of a large history. Reports which components re-render, how often, and how
 * long commits take. Run with:
 *
 *   SHOGO_E2E_REACT_PROFILE=1 PLAYWRIGHT_E2E=1 npx playwright test \
 *     --config e2e/playwright.config.ts render-profile.spec.ts
 *
 * Output: test-results/streaming-e2e/render-profile.json
 */
import { expect, test } from '@playwright/test'
import { launchTarget, send, waitIdle, writeReport, type Harness } from './desktop-app'
import { marker } from './fake-llm-server'
import { startRenderProfile, stopRenderProfile } from './react-profile'
import { beginProbe, readProbe } from './stream-probe'

test.skip(process.env.PLAYWRIGHT_E2E !== '1' || process.env.SHOGO_E2E_REACT_PROFILE !== '1', 'set PLAYWRIGHT_E2E=1 and SHOGO_E2E_REACT_PROFILE=1 to run')
test.setTimeout(1_200_000)

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback)
const HISTORY_TURNS = num('SHOGO_E2E_PROFILE_HISTORY_TURNS', 4)
const HISTORY_ROUNDS = num('SHOGO_E2E_PROFILE_HISTORY_ROUNDS', 25)
const ROUNDS = num('SHOGO_E2E_PROFILE_ROUNDS', 50)
const TOKENS_PER_ROUND = num('SHOGO_E2E_PROFILE_TOKENS_PER_ROUND', 40)

let h: Harness
test.beforeAll(async () => {
  test.setTimeout(600_000)
  h = await launchTarget()
})
test.afterAll(async () => {
  await h?.close()
})

async function turn(tag: string, rounds: number, profile: boolean) {
  const total = rounds * TOKENS_PER_ROUND
  await beginProbe(h.page, tag)
  if (profile) await startRenderProfile(h.page)
  await send(h.page, `${marker('tool', tag, total, { rounds })} go`)
  await h.llm.waitForTokens(tag, total, 900_000)
  await waitIdle(h.page, 120_000)
  const rp = profile ? await stopRenderProfile(h.page) : null
  return { rp, probe: await readProbe(h.page) }
}

test('chat panel renders during a long turn on a large history', async () => {
  // Profile the same turn shape at several history sizes so growth is visible.
  const runs: Array<{ historyTurns: number; profile: Awaited<ReturnType<typeof turn>>['rp']; longTasks: unknown; frames: unknown }> = []

  const first = await turn('p0', ROUNDS, true)
  runs.push({ historyTurns: 0, profile: first.rp, longTasks: first.probe.longTasks, frames: first.probe.frames })

  for (let i = 1; i <= HISTORY_TURNS; i++) await turn(`h${i}`, HISTORY_ROUNDS, false)

  const last = await turn('p1', ROUNDS, true)
  runs.push({ historyTurns: HISTORY_TURNS, profile: last.rp, longTasks: last.probe.longTasks, frames: last.probe.frames })

  writeReport('render-profile', { rounds: ROUNDS, historyRounds: HISTORY_ROUNDS, runs })
  const a = runs[0].profile!
  const b = runs[1].profile!
  // eslint-disable-next-line no-console
  console.log(
    `[render-profile] empty chat: ${a.commits} commits, p95 ${a.renderMs.p95}ms, max ${a.renderMs.max}ms | ` +
      `after ${HISTORY_TURNS} turns: ${b.commits} commits, p95 ${b.renderMs.p95}ms, max ${b.renderMs.max}ms`,
  )
  expect.soft(b.renderMs.max, 'slowest commit with a large history').toBeLessThanOrEqual(250)
})

test('chat panel renders while one very long text reply streams', async () => {
  // Markdown is re-parsed as the message grows, so cost can grow with its length.
  const tokens = num('SHOGO_E2E_PROFILE_LONG_TOKENS', 6000)
  const tag = 'lt'
  await beginProbe(h.page, tag)
  await startRenderProfile(h.page)
  await send(h.page, `${marker('long', tag, tokens, { ms: 4 })} go`)
  await h.llm.waitForTokens(tag, tokens, 600_000)
  await waitIdle(h.page, 120_000)
  const profile = await stopRenderProfile(h.page)
  const probe = await readProbe(h.page)
  writeReport('render-profile-long-text', { tokens, profile, longTasks: probe.longTasks, frames: probe.frames })
  // eslint-disable-next-line no-console
  console.log(`[render-profile] ${tokens}-token reply: ${profile.commits} commits, thirds mean ${profile.thirds.map((t) => t.meanMs).join('/')}ms, max ${profile.renderMs.max}ms, long tasks ${probe.longTasks.count} (max ${probe.longTasks.maxMs}ms)`)
  expect.soft(probe.longTasks.maxMs, 'longest UI stall').toBeLessThanOrEqual(250)
})
