// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Proxy Billing Session Tests
 *
 * Tests the session-based token accumulator that allows the AI proxy
 * to buffer usage across multiple API calls in an agentic loop and
 * charge once at the end.
 *
 * Run: bun test apps/api/src/__tests__/proxy-billing-session.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// Track calls to consumeCredits
let consumeCreditsCalls: any[] = []

mock.module('../services/billing.service', () => ({
  consumeCredits: async (...args: any[]) => {
    consumeCreditsCalls.push(args)
    return { success: true, remainingCredits: 99 }
  },
}))

// Must import AFTER mocking
import {
  openSession,
  closeSession,
  hasSession,
  accumulateUsage,
} from '../lib/proxy-billing-session'

describe('Proxy Billing Session', () => {
  beforeEach(() => {
    consumeCreditsCalls = []
  })

  test('openSession creates an active session', () => {
    openSession('proj-1', 'ws-1', 'user-1')
    expect(hasSession('proj-1')).toBe(true)
  })

  test('hasSession returns false for nonexistent session', () => {
    expect(hasSession('proj-nonexistent')).toBe(false)
  })

  test('accumulateUsage returns true when session is open', () => {
    openSession('proj-acc', 'ws-1', 'user-1')
    const result = accumulateUsage('proj-acc', 'sonnet', 1000, 500)
    expect(result).toBe(true)
  })

  test('accumulateUsage returns false when no session', () => {
    const result = accumulateUsage('proj-nosession', 'sonnet', 1000, 500)
    expect(result).toBe(false)
  })

  test('closeSession charges total tokens across multiple accumulations', async () => {
    openSession('proj-multi', 'ws-multi', 'user-multi')

    // Simulate 3 API calls in an agentic loop
    accumulateUsage('proj-multi', 'claude-sonnet-4-5', 5000, 1000)
    accumulateUsage('proj-multi', 'claude-sonnet-4-5', 5000, 2000)
    accumulateUsage('proj-multi', 'claude-sonnet-4-5', 5000, 3000)

    const { creditCost, totalTokens } = await closeSession('proj-multi')

    expect(totalTokens).toBe(21000) // 15000 input + 6000 output
    expect(creditCost).toBeGreaterThan(0)
    expect(hasSession('proj-multi')).toBe(false)

    // Should have called consumeCredits exactly once
    expect(consumeCreditsCalls.length).toBe(1)
    const [workspaceId, projectId, memberId, actionType, cost, metadata] = consumeCreditsCalls[0]
    expect(workspaceId).toBe('ws-multi')
    expect(projectId).toBe('proj-multi')
    expect(memberId).toBe('user-multi')
    expect(actionType).toBe('chat_message')
    expect(metadata.totalTokens).toBe(21000)
    expect(metadata.inputTokens).toBe(15000)
    expect(metadata.outputTokens).toBe(6000)
    expect(metadata.requestCount).toBe(3)
  })

  test('closeSession with no accumulated tokens charges nothing', async () => {
    openSession('proj-empty', 'ws-1', 'user-1')

    const { creditCost, totalTokens } = await closeSession('proj-empty')

    expect(totalTokens).toBe(0)
    expect(creditCost).toBe(0)
    expect(consumeCreditsCalls.length).toBe(0)
  })

  test('closeSession with no session returns zero', async () => {
    const { creditCost, totalTokens } = await closeSession('proj-none')

    expect(totalTokens).toBe(0)
    expect(creditCost).toBe(0)
    expect(consumeCreditsCalls.length).toBe(0)
  })

  test('session is removed after close', async () => {
    openSession('proj-remove', 'ws-1', 'user-1')
    accumulateUsage('proj-remove', 'sonnet', 100, 100)

    await closeSession('proj-remove')
    expect(hasSession('proj-remove')).toBe(false)

    // Accumulating after close should return false
    expect(accumulateUsage('proj-remove', 'sonnet', 100, 100)).toBe(false)
  })

  test('opening a new session overwrites existing one', async () => {
    openSession('proj-overwrite', 'ws-1', 'user-1')
    accumulateUsage('proj-overwrite', 'sonnet', 10000, 5000)

    // Opening again should flush the old session
    openSession('proj-overwrite', 'ws-2', 'user-2')

    // The old session's flush may be async, give it a tick
    await new Promise(r => setTimeout(r, 10))

    // New session should be fresh
    accumulateUsage('proj-overwrite', 'haiku', 100, 50)
    const { totalTokens } = await closeSession('proj-overwrite')

    // Should only have the new session's tokens
    expect(totalTokens).toBe(150)
  })

  test('single API call charges based on total tokens', async () => {
    openSession('proj-single', 'ws-1', 'user-1')
    accumulateUsage('proj-single', 'claude-sonnet-4-5', 2000, 1000)

    const { creditCost, totalTokens } = await closeSession('proj-single')

    // 3000 tokens at sonnet rate: (3000/5000) * 0.1 * 1.2 = 0.072, rounds up to 0.1
    expect(totalTokens).toBe(3000)
    expect(creditCost).toBe(0.1)
  })

  test('many small API calls charge based on total tokens', async () => {
    openSession('proj-many', 'ws-1', 'user-1')

    for (let i = 0; i < 5; i++) {
      accumulateUsage('proj-many', 'claude-sonnet-4-5', 400, 200)
    }

    const { creditCost, totalTokens } = await closeSession('proj-many')

    // 3000 tokens at sonnet rate: (3000/5000) * 0.1 * 1.2 = 0.072, rounds up to 0.1
    expect(totalTokens).toBe(3000)
    expect(creditCost).toBe(0.1)

    expect(consumeCreditsCalls.length).toBe(1)
  })
})
