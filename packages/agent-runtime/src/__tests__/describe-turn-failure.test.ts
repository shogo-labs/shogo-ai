// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * describeTurnFailure — user-facing error mapping.
 *
 * A failed turn's raw error is an internal wrapper ("Provider error:
 * Connection error.") or a raw upstream body. The gateway must NEVER echo that
 * to the client, and must pick a message that matches the real cause — using
 * the same `classifyRetryability` the agent loop used to retry the call.
 *
 * The regression these lock in: users saw
 *   "I encountered an issue processing your message: Provider error: Connection error."
 * because the old ad-hoc `isProviderError` regex had no connection/network
 * token, so the raw wrapper leaked through the generic branch. `Connection
 * error.` is the OpenAI SDK's APIConnectionError text surfaced when the runtime
 * can't reach the AI proxy (the 2026-07 metal provider-connection incidents).
 *
 * Run: bun test packages/agent-runtime/src/__tests__/describe-turn-failure.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { describeTurnFailure } from '../gateway'

describe('describeTurnFailure', () => {
  test('connection failures surface a retry message, not the raw wrapper', () => {
    const out = describeTurnFailure('Provider error: Connection error.')
    // The exact string users used to see must never leak.
    expect(out).not.toContain('Provider error')
    expect(out).not.toContain('Connection error')
    // Network faults are provider-independent, so we must NOT tell the user to
    // switch models — we ask them to retry.
    expect(out).not.toMatch(/switch to a different model/i)
    expect(out).toMatch(/try again/i)
  })

  test.each([
    'fetch failed',
    'ECONNREFUSED 10.0.0.1:8080',
    'socket hang up',
    'connection reset by peer',
  ])('classifies %p as a transient connection error', (raw) => {
    expect(describeTurnFailure(raw)).toMatch(/try again/i)
  })

  test('billing errors keep the exact usage-limit message the client maps on', () => {
    expect(describeTurnFailure('402 {"error":{"message":"usage limit reached"}}')).toBe(
      'Usage limit reached. Enable usage-based pricing, upgrade your plan, or check your AI provider settings.',
    )
  })

  test('auth failures ask the user to check provider settings (no model switch)', () => {
    const out = describeTurnFailure('401 Unauthorized: invalid API key')
    expect(out).toMatch(/provider settings/i)
    expect(out).not.toContain('API key')
  })

  test('overload / 5xx map to the model-unavailable message', () => {
    expect(describeTurnFailure('529 overloaded')).toMatch(/Model unavailable/i)
    expect(describeTurnFailure('503 service unavailable')).toMatch(/Model unavailable/i)
  })

  test('iteration-limit is treated as a continuable state, not a provider error', () => {
    expect(describeTurnFailure('Reached the maximum iteration limit')).toMatch(/continue/i)
  })

  test('content-policy blocks are explained, not leaked', () => {
    const out = describeTurnFailure('stop_reason: content_filter')
    expect(out).toMatch(/content filter/i)
  })

  test('unknown causes never echo the raw text and use the provided fallback', () => {
    const raw = 'Totally novel internal detail 0xDEADBEEF that must not reach users'
    expect(describeTurnFailure(raw)).toBe(
      'I encountered an issue processing your message. Please try again.',
    )
    expect(describeTurnFailure(raw, 'Please start a new conversation.')).toBe(
      'Please start a new conversation.',
    )
  })

  test('empty / nullish input yields a safe generic message', () => {
    expect(describeTurnFailure('')).toMatch(/issue processing your message/i)
    expect(describeTurnFailure(null)).toMatch(/issue processing your message/i)
    expect(describeTurnFailure(undefined)).toMatch(/issue processing your message/i)
  })
})
