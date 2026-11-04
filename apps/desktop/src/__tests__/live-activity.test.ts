// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-317 — one honest number for "an agent run a restart would interrupt".
 *
 * The banner said 19 when four agents were running, because the desktop added
 * three API counts together: live turns, every running background task (mostly
 * card watches, which survive a restart) and every running team-chat reply (the
 * same runs as the live turns). `agentRuns` is now the only thing the gate and
 * the copy read; `backgroundCommands` rides along to be mentioned, never counted.
 */
import { describe, expect, it } from 'bun:test'
import {
  NO_LIVE_ACTIVITY,
  describeLiveActivity,
  fetchLiveActivity,
  liveActivityTotal,
  type LiveActivityReport,
} from '../live-activity'

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = []
  const impl = (async (url: string) => {
    calls.push(String(url))
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('liveActivityTotal', () => {
  it('counts agent runs only — a background command never holds the restart', () => {
    expect(liveActivityTotal({ agentRuns: 4, backgroundCommands: 3 })).toBe(4)
    expect(liveActivityTotal({ agentRuns: 0, backgroundCommands: 7 })).toBe(0)
    expect(liveActivityTotal(null)).toBe(0)
    expect(liveActivityTotal(NO_LIVE_ACTIVITY)).toBe(0)
  })

  it('ignores nonsense instead of printing NaN', () => {
    expect(liveActivityTotal({ agentRuns: Number.NaN, backgroundCommands: 1 })).toBe(0)
    expect(liveActivityTotal({ agentRuns: -3, backgroundCommands: 1 })).toBe(0)
  })
})

describe('describeLiveActivity', () => {
  it('says how many agent runs are working', () => {
    expect(describeLiveActivity({ agentRuns: 1, backgroundCommands: 0 })).toBe('1 agent run is working')
    expect(describeLiveActivity({ agentRuns: 4, backgroundCommands: 0 })).toBe('4 agent runs are working')
  })

  it('adds the background-command clause only when there is one', () => {
    expect(describeLiveActivity({ agentRuns: 4, backgroundCommands: 2 })).toBe(
      '4 agent runs are working, and 2 background commands, which report back as interrupted',
    )
    expect(describeLiveActivity({ agentRuns: 4, backgroundCommands: 1 })).toBe(
      '4 agent runs are working, and 1 background command, which reports back as interrupted',
    )
  })

  it('does not claim agent runs when only a command is running', () => {
    expect(describeLiveActivity({ agentRuns: 0, backgroundCommands: 2 })).toBe('2 background commands are running')
  })
})

describe('fetchLiveActivity', () => {
  it('reads agentRuns and backgroundCommands from the API', async () => {
    const { impl } = fakeFetch({
      ok: true,
      agentRuns: 4,
      backgroundCommands: 1,
      // A watch count still in the payload must not change the answer.
      runningTasks: 7,
      sessions: [{ id: 's1', title: 'Ship it', workspaceId: 'w1' }],
    })

    const report = await fetchLiveActivity('http://127.0.0.1:8002', { fetchImpl: impl })
    expect(report).toMatchObject({ agentRuns: 4, backgroundCommands: 1 })
    expect(report?.sessions).toEqual([{ id: 's1', title: 'Ship it', workspaceId: 'w1' }])
    expect(liveActivityTotal(report as LiveActivityReport)).toBe(4)
  })

  it('falls back to an older API\'s liveTurns rather than reporting nothing live', async () => {
    const { impl } = fakeFetch({ ok: true, liveTurns: 2, runningTasks: 9, runningAgentReplies: 2 })

    const report = await fetchLiveActivity('http://127.0.0.1:8002', { fetchImpl: impl })
    // `runningTasks` is a watch count and `runningAgentReplies` duplicates the
    // turns: neither may resurface through the fallback.
    expect(report).toMatchObject({ agentRuns: 2, backgroundCommands: 0 })
  })

  it('is null when the API cannot answer', async () => {
    const { impl } = fakeFetch(null, { ok: false, status: 500 })
    expect(await fetchLiveActivity('http://127.0.0.1:8002', { fetchImpl: impl })).toBeNull()

    const broken = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await fetchLiveActivity('http://127.0.0.1:8002', { fetchImpl: broken })).toBeNull()
  })
})
