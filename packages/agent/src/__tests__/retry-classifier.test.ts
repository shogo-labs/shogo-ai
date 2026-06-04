// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the inference retryability classifier.
 *
 * Run: bun test packages/agent/src/__tests__/retry-classifier.test.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  classifyRetryability,
  parseStreamErrorMarker,
  stripStreamErrorMarker,
} from '../retry-classifier'

describe('classifyRetryability — retryable failures', () => {
  const retryable: Array<[string, string]> = [
    ['ECONNRESET', 'read ECONNRESET'],
    ['fetch failed', 'TypeError: fetch failed'],
    ['socket hang up', 'socket hang up'],
    ['ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.1:443'],
    ['mid-stream 500', 'Upstream anthropic returned 500 internal server error'],
    ['502', '502 Bad Gateway'],
    ['503', '503 Service Unavailable'],
    ['overloaded', '{"type":"overloaded_error","message":"Overloaded"}'],
    ['429', '429 Too Many Requests'],
    [
      'idle_timeout (with proxy marker)',
      'No data from anthropic for 120000ms; giving up. Please retry. [shogo:retryable=true;code=idle_timeout]',
    ],
    [
      'EOF before message_stop',
      'Upstream anthropic stream ended without message_stop after 5000ms (likely network drop). Please retry.',
    ],
    ['premature close', 'Error: Premature close'],
  ]

  for (const [label, message] of retryable) {
    test(`retryable: ${label}`, () => {
      expect(classifyRetryability({ message }).retryable).toBe(true)
    })
  }
})

describe('classifyRetryability — non-retryable failures', () => {
  const nonRetryable: Array<[string, string]> = [
    ['401 auth', '401 Unauthorized'],
    ['403 auth', '403 {"error":{"message":"permission denied"}}'],
    ['invalid api key', 'Authentication error: invalid api key'],
    ['400 invalid_request', '400 {"type":"invalid_request_error","message":"bad params"}'],
    ['content policy', 'Your request was flagged by our content policy'],
    ['content_filter', 'stop_reason: content_filter'],
    ['billing', '402 billing_error: insufficient credits'],
  ]

  for (const [label, message] of nonRetryable) {
    test(`non-retryable: ${label}`, () => {
      expect(classifyRetryability({ message }).retryable).toBe(false)
    })
  }

  test('user abort is never retryable (even with a retryable-looking message)', () => {
    expect(classifyRetryability({ message: 'socket hang up', aborted: true }).retryable).toBe(false)
    expect(classifyRetryability({ message: 'ECONNRESET', stopReason: 'aborted' }).retryable).toBe(false)
    expect(classifyRetryability({ aborted: true }).reason).toBe('aborted')
  })

  test('unknown errors are conservatively non-retryable', () => {
    const c = classifyRetryability({ message: 'something totally unexpected happened' })
    expect(c.retryable).toBe(false)
    expect(c.reason).toBe('unknown')
  })
})

describe('classifyRetryability — status codes', () => {
  test('5xx retryable', () => {
    expect(classifyRetryability({ status: 500 }).retryable).toBe(true)
    expect(classifyRetryability({ status: 503 }).retryable).toBe(true)
  })
  test('429 retryable', () => {
    expect(classifyRetryability({ status: 429 }).retryable).toBe(true)
  })
  test('401/403/400 non-retryable', () => {
    expect(classifyRetryability({ status: 401 }).retryable).toBe(false)
    expect(classifyRetryability({ status: 403 }).retryable).toBe(false)
    expect(classifyRetryability({ status: 400 }).retryable).toBe(false)
  })
})

describe('classifyRetryability — structured proxy marker propagation', () => {
  test('marker retryable=true classifies retryable regardless of prose', () => {
    const message =
      'Upstream anthropic stream dropped. Please retry. [shogo:retryable=true;code=upstream_truncated]'
    const c = classifyRetryability({ message })
    expect(c.retryable).toBe(true)
    expect(c.reason).toBe('truncated')
  })

  test('marker retryable=false classifies non-retryable even with retryable-looking text', () => {
    // Prose says "stream" / "retry" (retryable-looking) but the structured
    // flag is authoritative: upstream_error is a definitive failure.
    const message =
      'Upstream stream error. Please retry. [shogo:retryable=false;code=upstream_error]'
    const c = classifyRetryability({ message })
    expect(c.retryable).toBe(false)
    expect(c.reason).toBe('upstream_error')
  })

  test('parseStreamErrorMarker extracts the flag + code', () => {
    expect(parseStreamErrorMarker('x [shogo:retryable=true;code=idle_timeout]')).toEqual({
      retryable: true,
      code: 'idle_timeout',
    })
    expect(parseStreamErrorMarker('no marker here')).toBeNull()
  })

  test('stripStreamErrorMarker removes the internal marker', () => {
    expect(
      stripStreamErrorMarker('Connection lost. Please retry. [shogo:retryable=true;code=econnreset]'),
    ).toBe('Connection lost. Please retry.')
  })

  test('explicit retryable override is honored when no marker present', () => {
    expect(classifyRetryability({ message: 'weird', retryable: true }).retryable).toBe(true)
    expect(classifyRetryability({ message: 'weird', retryable: false }).retryable).toBe(false)
  })
})
