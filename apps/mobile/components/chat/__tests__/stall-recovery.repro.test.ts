// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRODUCTION of the SECOND reason the production incident ended on a dead-end
 * banner instead of a transient "Reconnecting…".
 *
 * From the client logs, right before the failed re-send:
 *   GET /api/projects/d9d1f5a6…/turn        → 404
 *   GET /api/local/projects/d9d1f5a6…       → 404
 *
 * A 404 on the `/turn` probe means the request landed on a pod/region that does
 * not own the session (lost Cloudflare `__cflb` affinity, or the row hasn't
 * replicated yet). `probeChatTurnStatus` collapses 404 → "unknown", and after
 * the bounded poll budget `decideStallRecovery("unknown")` returns "give-up" —
 * so the auto-recovery layer cannot reattach and the UI falls through to the
 * static "tap Retry" banner even though the agent may still be running.
 *
 * This test drives the REAL probe against a 404 and confirms the full chain
 * lands on "give-up". The production fix then converts that give-up into a
 * local fail-closed UI state so active tasks do not spin forever.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/stall-recovery.repro.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { probeChatTurnStatus } from '../probe-turn-status'
import { decideStallGiveUpAction, decideStallRecovery } from '../stall-recovery'

const TURN_URL = 'https://api.example.com/api/projects/d9d1f5a6/chat/98731fc1/turn'

describe('REPRODUCTION: /turn 404 (lost session affinity) → auto-recovery gives up', () => {
  test('a 404 turn probe normalizes to "unknown"', async () => {
    const fetch404: any = async () => new Response('404 Not Found', { status: 404 })
    const status = await probeChatTurnStatus({ url: TURN_URL, fetch: fetch404 })
    expect(status).toBe('unknown')
  })

  test('bounded poll on a persistently-404 turn exhausts and gives up', async () => {
    const MAX_ATTEMPTS = 5
    const fetch404: any = async () => new Response('404 Not Found', { status: 404 })

    const actions: string[] = []
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const turnStatus = await probeChatTurnStatus({ url: TURN_URL, fetch: fetch404 })
      actions.push(decideStallRecovery({ turnStatus, attempt, maxAttempts: MAX_ATTEMPTS }))
    }

    // Every intermediate attempt only buys "retry-later"; the final attempt
    // gives up. The follow-up give-up decision must then fail-closed locally
    // instead of leaving the turn visually active forever.
    expect(actions).not.toContain('reconnect')
    expect(actions[actions.length - 1]).toBe('give-up')
    expect(actions.slice(0, -1).every((a) => a === 'retry-later')).toBe(true)
    expect(decideStallGiveUpAction({ turnStatus: 'unknown', userInitiatedStop: false })).toBe('fail-closed')
  })

  test('a raw network throw on the probe also collapses to unknown → give-up', async () => {
    const fetchThrows: any = async () => {
      throw new TypeError('network error')
    }
    const turnStatus = await probeChatTurnStatus({ url: TURN_URL, fetch: fetchThrows })
    expect(turnStatus).toBe('unknown')
    expect(decideStallRecovery({ turnStatus, attempt: 5, maxAttempts: 5 })).toBe('give-up')
    expect(decideStallGiveUpAction({ turnStatus, userInitiatedStop: false })).toBe('fail-closed')
  })
})
