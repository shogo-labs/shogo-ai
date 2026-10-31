// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-270. Every string below is a real failure from production (30 days of
 * `chat_messages`: 747 of 18,054 assistant turns ended in the fallback text).
 * The classifier must name each one so the turn can end with its own recovery
 * instead of "the last model call hit a recoverable provider error: <raw>".
 */
import { describe, expect, it } from 'bun:test'
import {
  buildTurnFailureMessage,
  classifyTurnFailure,
  isFailoverFailure,
  isUsageLimitFailure,
  type TurnFailureClass,
} from '../retry-classifier'

interface Fixture {
  raw: string
  stopReason?: string
  abortReason?: 'external' | 'max_iterations' | 'loop_detected'
  expected: TurnFailureClass
  /** How prod buckets it (for the reader, not the assertion). */
  bucket: string
}

const PROD_FAILURES: Fixture[] = [
  // 389 turns (52%) — out of credit, wording varies by gateway.
  {
    bucket: 'usage limit (AI proxy)',
    raw: '402 {"error":{"message":"Usage limit reached. Enable usage-based pricing or upgrade your plan.","code":"usage_limit_reached"}}',
    expected: 'usage_limit',
  },
  {
    bucket: 'usage limit (OpenAI-compatible / Hoshi)',
    raw: "402 You've reached your usage limit. Please check your plan and billing details.",
    expected: 'usage_limit',
  },
  {
    bucket: 'usage limit (spending cap)',
    raw: '402 {"error":{"code":"overage_cap_reached","message":"You have reached your spending cap"}}',
    expected: 'usage_limit',
  },
  {
    bucket: 'usage limit (payment pending)',
    raw: '402 {"error":{"code":"overage_payment_pending","message":"Your payment is still pending"}}',
    expected: 'usage_limit',
  },
  // 297 turns (40%) — the iteration ceiling, reported as an abort.
  { bucket: 'iteration ceiling', raw: 'Request was aborted.', abortReason: 'max_iterations', expected: 'iteration_ceiling' },
  { bucket: 'iteration ceiling (no error text)', raw: '', abortReason: 'max_iterations', expected: 'iteration_ceiling' },
  // ~50 turns (7%) — provider 400s.
  { bucket: 'openrouter upstream', raw: '400 Provider returned error', expected: 'upstream_400' },
  { bucket: 'deepseek content filter', raw: '400 Content Exists Risk', expected: 'content_filter' },
  {
    bucket: 'unsupported image',
    raw: '400 {"type":"invalid_request_error","message":".messages[113].image[0]: You have uploaded an unsupported image"}',
    expected: 'bad_image',
  },
  {
    bucket: 'bad tool id',
    raw: "400 messages.1.content.0.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'",
    expected: 'bad_tool_id',
  },
  { bucket: 'too large', raw: '500 custom API error (413): Request entity too large', expected: 'too_large' },
  { bucket: 'too large (plain)', raw: '413 payload too large', expected: 'too_large' },
  // 3 local turns — Anthropic's own refusal, via the pi-ai patch.
  { bucket: 'anthropic refusal', raw: 'Model refused this request (stop_reason=refusal)', expected: 'refusal' },
  { bucket: 'anthropic sensitive', raw: 'Model refused this request (stop_reason=sensitive)', expected: 'refusal' },
  { bucket: 'anthropic refusal (stopReason only)', raw: 'An unknown error occurred', stopReason: 'refusal', expected: 'refusal' },
  // 2 turns — already retried; classed only so the telemetry bucket is honest.
  { bucket: 'network blip', raw: 'Connection error.', expected: 'network' },
  { bucket: 'dropped stream', raw: 'Stream ended without message_stop', expected: 'network' },
  // A user stop is never a failure.
  { bucket: 'user stop', raw: 'Request was aborted.', abortReason: 'external', expected: 'aborted_by_user' },
  { bucket: 'user stop wins over text', raw: '402 You have reached your usage limit', abortReason: 'external', expected: 'aborted_by_user' },
  // Our own malformed payload, not a provider-side 400: no failover helps.
  {
    bucket: 'request shape 400 (roles must alternate)',
    raw: '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: roles must alternate between \\"user\\" and \\"assistant\\""}}',
    expected: 'invalid_request',
  },
  { bucket: 'tool-call id crash in our code', raw: 'msg.content.map is not a function', expected: 'unknown' },
  { bucket: 'JS identifier naming a tool call id', raw: 'TypeError in sanitizeToolCallIds(toolCallId)', expected: 'unknown' },
]

describe('classifyTurnFailure — production fixtures', () => {
  for (const f of PROD_FAILURES) {
    it(`${f.bucket}: ${f.raw.slice(0, 60) || '(no text)'}`, () => {
      expect(
        classifyTurnFailure({ rawError: f.raw, stopReason: f.stopReason, abortReason: f.abortReason }),
      ).toBe(f.expected)
    })
  }

  it('an upstream provider billing failure is not a usage limit', () => {
    const raw = '402 {"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low"}}'
    expect(classifyTurnFailure({ rawError: raw })).not.toBe('usage_limit')
    expect(isUsageLimitFailure(raw)).toBe(false)
  })

  it('a usage limit is never mistaken for a refusal or an upstream 400', () => {
    expect(classifyTurnFailure({ rawError: "402 You've reached your usage limit" })).toBe('usage_limit')
  })

  it('classifies an empty turn with no signal as unknown', () => {
    expect(classifyTurnFailure({})).toBe('unknown')
  })
})

describe('isFailoverFailure', () => {
  it('only refusals, content filters and upstream 400s get a cross-family retry', () => {
    expect(isFailoverFailure('refusal')).toBe(true)
    expect(isFailoverFailure('content_filter')).toBe(true)
    expect(isFailoverFailure('upstream_400')).toBe(true)
    for (const cls of ['usage_limit', 'iteration_ceiling', 'network', 'unknown', 'bad_image', 'bad_tool_id', 'too_large', 'aborted_by_user', 'invalid_request'] as TurnFailureClass[]) {
      expect(isFailoverFailure(cls)).toBe(false)
    }
  })
})

describe('buildTurnFailureMessage', () => {
  it('the ceiling reads as a step limit, never as an abort or a provider error', () => {
    const text = buildTurnFailureMessage('iteration_ceiling', 4)
    expect(text).toContain('step limit')
    expect(text).toContain('4 steps')
    expect(text.toLowerCase()).not.toContain('abort')
    expect(text.toLowerCase()).not.toContain('provider error')
  })

  it('never leaks provider text and always says the work is saved', () => {
    for (const cls of ['unknown', 'refusal', 'network', 'bad_image'] as TurnFailureClass[]) {
      const text = buildTurnFailureMessage(cls, 2)
      expect(text).not.toContain('402')
      expect(text).not.toContain('stop_reason')
      expect(text.toLowerCase()).toContain('saved')
    }
  })

  it('speaks about the completed steps it actually preserved', () => {
    expect(buildTurnFailureMessage('unknown', 0)).not.toContain('I completed')
    expect(buildTurnFailureMessage('unknown', 1)).toContain('1 step ')
    expect(buildTurnFailureMessage('unknown', 3)).toContain('3 steps')
  })
})
