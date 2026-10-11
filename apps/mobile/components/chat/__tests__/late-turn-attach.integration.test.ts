// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The chat panel keeps probing when a channel dispatch or a delegated task
 * has no reply yet. These tests drive that probe directly: ChatPanel's effect
 * calls the same pollForLateTurn.
 */

import { describe, expect, test } from 'bun:test'
import { recordAutoResumeAttempt } from '../auto-resume-circuit-breaker'
import {
  externalPromptHasResponse,
  pendingExternalPromptIndex,
  pollForLateTurn,
} from '../late-turn-attach'
import type { ChatTurnStatus } from '../probe-turn-status'

const DELEGATED = "This is a delegated task from the user's task list:"

function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
  }
}

describe('late turn polling', () => {
  test('a delegated task is still pending until an assistant reply follows it', () => {
    const waiting = [{ role: 'user', content: `${DELEGATED} fix the build` }]
    expect(pendingExternalPromptIndex(waiting)).toBe(0)
    expect(externalPromptHasResponse(waiting, 0)).toBe(false)
    const answered = [...waiting, { role: 'assistant', content: 'Fixed.' }]
    expect(externalPromptHasResponse(answered, pendingExternalPromptIndex(answered))).toBe(true)
    expect(pendingExternalPromptIndex([{ role: 'user', content: 'hello' }])).toBe(-1)
  })

  test('attaches once the turn becomes active, and only once', async () => {
    let probes = 0
    let attached = 0
    const time = clock()
    await pollForLateTurn({
      probe: async () => {
        probes += 1
        return (probes >= 3 ? 'active' : 'unknown') as ChatTurnStatus
      },
      attach: () => { attached += 1 },
      reload: async () => {},
      intervalMs: 1_000,
      maxWaitMs: 60_000,
      now: time.now,
      sleep: time.sleep,
    })
    expect(probes).toBe(3)
    expect(attached).toBe(1)
  })

  test('a run that finishes first is reloaded and the stream is not opened', async () => {
    let reloads = 0
    let attached = 0
    let saved = false
    await pollForLateTurn({
      probe: async () => 'completed',
      attach: () => { attached += 1 },
      reload: async () => { reloads += 1; saved = true },
      isCancelled: () => saved,
      intervalMs: 1_000,
      maxWaitMs: 60_000,
      now: () => 0,
      sleep: async () => {},
    })
    expect(reloads).toBe(1)
    expect(attached).toBe(0)
  })

  test('polling stops at the cap without attaching or tripping the auto-resume breaker', async () => {
    let probes = 0
    let attached = 0
    const time = clock()
    const attempts: number[] = []
    await pollForLateTurn({
      probe: async () => { probes += 1; return 'unknown' },
      attach: () => {
        attached += 1
        attempts.push(...recordAutoResumeAttempt(attempts, Date.now()).timestamps)
      },
      reload: async () => {},
      intervalMs: 1_000,
      maxWaitMs: 2_500,
      now: time.now,
      sleep: time.sleep,
    })
    expect(attached).toBe(0)
    expect(attempts).toHaveLength(0)
    expect(probes).toBeGreaterThan(0)
    expect(probes).toBeLessThan(6)
  })

  test('cancelling between probes, as a session switch does, stops the poller', async () => {
    let probes = 0
    let cancelled = false
    await pollForLateTurn({
      probe: async () => { probes += 1; return 'unknown' },
      attach: () => { throw new Error('attached after cancel') },
      reload: async () => {},
      isCancelled: () => cancelled,
      intervalMs: 1_000,
      maxWaitMs: 60_000,
      now: () => 0,
      sleep: async () => { cancelled = true },
    })
    expect(probes).toBe(1)
  })
})
