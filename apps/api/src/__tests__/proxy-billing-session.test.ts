// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Proxy Billing Session Tests
 *
 * Tests the session-based token accumulator that allows the AI proxy
 * to buffer usage across multiple API calls in an agentic loop and
 * charge once at the end — in USD (raw provider cost + MARKUP_MULTIPLIER).
 *
 * Run: bun test apps/api/src/__tests__/proxy-billing-session.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

import { MARKUP_MULTIPLIER } from '../lib/usage-cost'

// Track calls to consumeUsage (new single-object-arg API)
let consumeUsageCalls: any[] = []

mock.module('../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    return { success: true, remainingIncludedUsd: 99 }
  },
}))

// Must import AFTER mocking
import {
  openSession,
  closeSession,
  hasSession,
  accumulateUsage,
  accumulateImageUsage,
} from '../lib/proxy-billing-session'

describe('Proxy Billing Session', () => {
  beforeEach(() => {
    consumeUsageCalls = []
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

    const { billedUsd, rawUsd, totalTokens } = await closeSession('proj-multi')

    expect(totalTokens).toBe(21000) // 15000 input + 6000 output
    expect(rawUsd).toBeGreaterThan(0)
    expect(billedUsd).toBeGreaterThan(0)
    expect(billedUsd).toBeCloseTo(rawUsd * MARKUP_MULTIPLIER, 10)
    expect(hasSession('proj-multi')).toBe(false)

    // Should have called consumeUsage exactly once
    expect(consumeUsageCalls.length).toBe(1)
    const args = consumeUsageCalls[0]
    expect(args.workspaceId).toBe('ws-multi')
    expect(args.projectId).toBe('proj-multi')
    expect(args.memberId).toBe('user-multi')
    expect(args.actionType).toBe('chat_message')
    expect(args.rawUsd).toBeCloseTo(rawUsd, 10)
    expect(args.billedUsd).toBeCloseTo(billedUsd, 10)
    expect(args.actionMetadata.totalTokens).toBe(21000)
    expect(args.actionMetadata.inputTokens).toBe(15000)
    expect(args.actionMetadata.outputTokens).toBe(6000)
    expect(args.actionMetadata.requestCount).toBe(3)
  })

  test('closeSession with no accumulated tokens charges nothing', async () => {
    openSession('proj-empty', 'ws-1', 'user-1')

    const { billedUsd, rawUsd, totalTokens } = await closeSession('proj-empty')

    expect(totalTokens).toBe(0)
    expect(billedUsd).toBe(0)
    expect(rawUsd).toBe(0)
    expect(consumeUsageCalls.length).toBe(0)
  })

  test('closeSession with no session returns zero', async () => {
    const { billedUsd, rawUsd, totalTokens } = await closeSession('proj-none')

    expect(totalTokens).toBe(0)
    expect(billedUsd).toBe(0)
    expect(rawUsd).toBe(0)
    expect(consumeUsageCalls.length).toBe(0)
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
    await new Promise((r) => setTimeout(r, 10))

    // New session should be fresh
    accumulateUsage('proj-overwrite', 'haiku', 100, 50)
    const { totalTokens } = await closeSession('proj-overwrite')

    // Should only have the new session's tokens
    expect(totalTokens).toBe(150)
  })

  test('single API call charges billedUsd = rawUsd * MARKUP_MULTIPLIER', async () => {
    openSession('proj-single', 'ws-1', 'user-1')
    accumulateUsage('proj-single', 'claude-sonnet-4-5', 2000, 1000)

    const { billedUsd, rawUsd, totalTokens } = await closeSession('proj-single')

    // Sonnet: (2000 * $3/1M) + (1000 * $15/1M) = $0.021 raw
    expect(totalTokens).toBe(3000)
    expect(rawUsd).toBeCloseTo(0.021, 6)
    expect(billedUsd).toBeCloseTo(0.021 * MARKUP_MULTIPLIER, 6)
  })

  test('many small API calls charge based on accumulated split tokens', async () => {
    openSession('proj-many', 'ws-1', 'user-1')

    for (let i = 0; i < 5; i++) {
      accumulateUsage('proj-many', 'claude-sonnet-4-5', 400, 200)
    }

    const { billedUsd, rawUsd, totalTokens } = await closeSession('proj-many')

    // 2000 input + 1000 output, same totals as single call above
    expect(totalTokens).toBe(3000)
    expect(rawUsd).toBeCloseTo(0.021, 6)
    expect(billedUsd).toBeCloseTo(0.021 * MARKUP_MULTIPLIER, 6)

    expect(consumeUsageCalls.length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // discardPartial — added when /agent/chat streams that EOF without ever
  // emitting `data-turn-complete` started showing up in staging logs as
  // "PARTIAL" persists. The route now passes `discardPartial: true` so the
  // user is not billed for a turn the upstream activator timed out on.
  // -------------------------------------------------------------------------
  describe('closeSession({ discardPartial })', () => {
    test('drops the session without invoking consumeUsage', async () => {
      openSession('proj-discard', 'ws-d', 'user-d')
      accumulateUsage('proj-discard', 'claude-sonnet-4-5', 5000, 2500)

      const result = await closeSession('proj-discard', { discardPartial: true })

      // Tokens are reported (so callers can log them) but no money was charged.
      expect(result.totalTokens).toBe(7500)
      expect(result.billedUsd).toBe(0)
      expect(result.rawUsd).toBe(0)

      // Critical: nothing was sent to the billing service.
      expect(consumeUsageCalls.length).toBe(0)

      // Session is removed so the next openSession on the same project is fresh.
      expect(hasSession('proj-discard')).toBe(false)
    })

    test('discardPartial=false (default) still charges normally', async () => {
      openSession('proj-charge', 'ws-c', 'user-c')
      accumulateUsage('proj-charge', 'claude-sonnet-4-5', 1000, 500)

      const result = await closeSession('proj-charge')

      expect(result.totalTokens).toBe(1500)
      expect(result.billedUsd).toBeGreaterThan(0)
      expect(consumeUsageCalls.length).toBe(1)
    })

    test('discardPartial on a zero-token session is a no-op (no log spam)', async () => {
      openSession('proj-empty-discard', 'ws-1', 'user-1')

      const result = await closeSession('proj-empty-discard', { discardPartial: true })

      expect(result.totalTokens).toBe(0)
      expect(result.billedUsd).toBe(0)
      expect(consumeUsageCalls.length).toBe(0)
    })

    test('discardPartial on a missing session returns zeros without error', async () => {
      const result = await closeSession('never-opened', { discardPartial: true })

      expect(result.totalTokens).toBe(0)
      expect(result.billedUsd).toBe(0)
      expect(consumeUsageCalls.length).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // accumulateImageUsage — folds image-generation USD into the same chat
  // turn so a turn that calls `generate_image` does NOT emit a separate
  // `ai_image_generation` row in addition to the `chat_message` row.
  // -------------------------------------------------------------------------
  describe('accumulateImageUsage', () => {
    test('returns true when session is open, false when not', () => {
      openSession('proj-img-on', 'ws-1', 'user-1')
      expect(accumulateImageUsage('proj-img-on', 'gpt-image-1', 0.04, 0.06)).toBe(true)

      expect(accumulateImageUsage('proj-img-off', 'gpt-image-1', 0.04, 0.06)).toBe(false)
    })

    test('image-only turn still bills via chat_message (single event)', async () => {
      openSession('proj-img-only', 'ws-img', 'user-img')
      accumulateImageUsage('proj-img-only', 'gpt-image-1', 0.04, 0.06)
      accumulateImageUsage('proj-img-only', 'gpt-image-1', 0.04, 0.06)

      const { rawUsd, billedUsd } = await closeSession('proj-img-only')

      expect(rawUsd).toBeCloseTo(0.08, 6)
      expect(billedUsd).toBeCloseTo(0.12, 6)

      // Critical: ONE consumeUsage call, with `chat_message` actionType.
      // The image USD was rolled into the chat-turn debit, NOT emitted
      // as a separate `ai_image_generation` row.
      expect(consumeUsageCalls.length).toBe(1)
      const args = consumeUsageCalls[0]
      expect(args.actionType).toBe('chat_message')
      expect(args.actionMetadata.imageGenerationCount).toBe(2)
      expect(args.actionMetadata.imageBilledUsd).toBeCloseTo(0.12, 6)
      expect(args.actionMetadata.imageRawUsd).toBeCloseTo(0.08, 6)
      expect(args.actionMetadata.imageModels).toEqual(['gpt-image-1'])
    })

    test('mixed token + image turn rolls both into a single chat_message debit', async () => {
      openSession('proj-mixed', 'ws-mixed', 'user-mixed')
      accumulateUsage('proj-mixed', 'claude-sonnet-4-5', 1000, 500)
      accumulateImageUsage('proj-mixed', 'gpt-image-1', 0.04, 0.06)
      accumulateUsage('proj-mixed', 'claude-sonnet-4-5', 500, 250)

      const { rawUsd, billedUsd, totalTokens } = await closeSession('proj-mixed')

      expect(totalTokens).toBe(2250)

      // Token cost: 1500 in + 750 out at sonnet rates = 0.0045 + 0.01125 = 0.01575 raw
      const expectedTokenRaw = 1500 * 0.000003 + 750 * 0.000015
      const expectedTokenBilled = expectedTokenRaw * MARKUP_MULTIPLIER

      expect(rawUsd).toBeCloseTo(expectedTokenRaw + 0.04, 6)
      expect(billedUsd).toBeCloseTo(expectedTokenBilled + 0.06, 6)

      expect(consumeUsageCalls.length).toBe(1)
      const args = consumeUsageCalls[0]
      expect(args.actionType).toBe('chat_message')
      expect(args.actionMetadata.imageGenerationCount).toBe(1)
      expect(args.actionMetadata.tokenRawUsd).toBeCloseTo(expectedTokenRaw, 6)
      expect(args.actionMetadata.tokenBilledUsd).toBeCloseTo(expectedTokenBilled, 6)
      expect(args.actionMetadata.imageBilledUsd).toBeCloseTo(0.06, 6)
    })

    test('discardPartial drops accumulated image USD too', async () => {
      openSession('proj-img-discard', 'ws-1', 'user-1')
      accumulateImageUsage('proj-img-discard', 'gpt-image-1', 0.04, 0.06)
      accumulateUsage('proj-img-discard', 'claude-sonnet-4-5', 100, 50)

      const result = await closeSession('proj-img-discard', { discardPartial: true })

      expect(result.billedUsd).toBe(0)
      expect(result.rawUsd).toBe(0)
      expect(consumeUsageCalls.length).toBe(0)
      expect(hasSession('proj-img-discard')).toBe(false)
    })

    test('image accumulation tracks distinct models in metadata', async () => {
      openSession('proj-img-models', 'ws-1', 'user-1')
      accumulateImageUsage('proj-img-models', 'gpt-image-1', 0.04, 0.06)
      accumulateImageUsage('proj-img-models', 'imagen-4', 0.02, 0.03)
      accumulateImageUsage('proj-img-models', 'gpt-image-1', 0.04, 0.06)

      await closeSession('proj-img-models')

      expect(consumeUsageCalls.length).toBe(1)
      const args = consumeUsageCalls[0]
      expect(args.actionMetadata.imageGenerationCount).toBe(3)
      expect(args.actionMetadata.imageModels.sort()).toEqual(['gpt-image-1', 'imagen-4'])
    })
  })
})
