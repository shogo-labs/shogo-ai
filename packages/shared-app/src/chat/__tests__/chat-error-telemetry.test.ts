// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for chat stream-error telemetry.
 *
 * Context: the "Connection interrupted. Please tap Retry to continue." class
 * (net::ERR_HTTP2_PROTOCOL_ERROR → TypeError: network error / Failed to fetch /
 * TimeoutError: signal timed out) was handled console-only and never reached
 * Sentry — silent user-facing pain. These pin the classification that decides
 * what gets reported, and the structured report shape (including the marker tag
 * that keeps it out of the noise filter).
 */
import { describe, test, expect } from 'bun:test'
import {
  classifyChatError,
  shouldReportChatError,
  buildChatStreamErrorReport,
  SHOGO_TELEMETRY_TAG,
} from '../chat-error-telemetry'

describe('classifyChatError', () => {
  test('genuine transport/connection failures → "connection"', () => {
    expect(classifyChatError(new TypeError('Failed to fetch'))).toBe('connection')
    expect(classifyChatError(new TypeError('network error'))).toBe('connection')
    expect(classifyChatError({ name: 'TimeoutError', message: 'signal timed out' })).toBe('connection')
    expect(classifyChatError('net::ERR_HTTP2_PROTOCOL_ERROR')).toBe('connection')
    expect(classifyChatError('terminated')).toBe('connection')
    expect(classifyChatError('Connection interrupted. Please tap Retry to continue.')).toBe('connection')
  })

  test('user-initiated aborts → "user-abort" (never reported)', () => {
    expect(classifyChatError({ name: 'AbortError', message: 'The user aborted a request.' })).toBe('user-abort')
    expect(classifyChatError(new Error('BodyStreamBuffer was aborted'))).toBe('user-abort')
    expect(classifyChatError(new Error('The operation was aborted'))).toBe('user-abort')
    // Explicit stop signal wins even over connection-looking text.
    expect(classifyChatError(new TypeError('Failed to fetch'), /* userInitiatedStop */ true)).toBe('user-abort')
  })

  test('anything else → "other" (still reported — no more silent failures)', () => {
    expect(classifyChatError(new Error('Request failed with status 500'))).toBe('other')
    expect(classifyChatError(new Error('Agent returned empty response'))).toBe('other')
  })

  test('expected server states (usage/rate limit) → "expected" (never reported)', () => {
    // Regression (Sentry JAVASCRIPT-REACT-45, >1k events): the resolved
    // friendly message that the chat renders to the user.
    expect(
      classifyChatError(
        new Error(
          'Usage limit reached. Enable usage-based pricing, upgrade your plan, or check your AI provider settings.',
        ),
      ),
    ).toBe('expected')
    // The raw error code form, before it's mapped to a friendly message.
    expect(classifyChatError(new Error('{"error":{"code":"usage_limit_reached"}}'))).toBe('expected')
    expect(classifyChatError(new Error('{"error":{"code":"insufficient_credits"}}'))).toBe('expected')
    expect(classifyChatError(new Error('{"error":{"code":"rate_limit_exceeded"}}'))).toBe('expected')
    expect(classifyChatError(new Error("You're sending messages too quickly. Please wait a moment and try again.")))
      .toBe('expected')
  })

  test('AI SDK stream parse failures → "parse" (not misfiled as "connection")', () => {
    expect(classifyChatError({ name: 'AI_JSONParseError', message: 'JSON parsing failed: Text: {...}' }))
      .toBe('parse')
    expect(classifyChatError(new Error('JSON Parse error: Expected \'}\''))).toBe('parse')
    // Regression (Sentry JAVASCRIPT-REACT-46): the `AI_JSONParseError` message
    // embeds the whole tool-output payload, which for a browser-QA turn
    // literally contains "network errors" — that must NOT flip it to
    // "connection". The parse check runs first and matches the name.
    const embeddedPayload =
      'JSON parsing failed: Text: {"type":"tool-output-available",' +
      '"output":{"text":"run browser tests to check for console and network errors"}}'
    expect(classifyChatError({ name: 'AI_JSONParseError', message: embeddedPayload })).toBe('parse')
    // Even without the SDK error name, the message prefix is enough.
    expect(classifyChatError(new Error(embeddedPayload))).toBe('parse')
  })
})

describe('shouldReportChatError', () => {
  test('reports connection + other, skips user aborts and expected states', () => {
    expect(shouldReportChatError(new TypeError('Failed to fetch'))).toBe(true)
    expect(shouldReportChatError(new Error('boom'))).toBe(true)
    expect(shouldReportChatError({ name: 'AbortError', message: 'aborted' })).toBe(false)
    expect(shouldReportChatError(new TypeError('Failed to fetch'), true)).toBe(false)
    // Expected business states are handled + user-facing → not reported.
    expect(shouldReportChatError(new Error('Usage limit reached. Enable usage-based pricing.'))).toBe(false)
    expect(shouldReportChatError(new Error('{"error":{"code":"rate_limit_exceeded"}}'))).toBe(false)
  })
})

describe('buildChatStreamErrorReport', () => {
  test('returns null for user aborts', () => {
    expect(buildChatStreamErrorReport({ name: 'AbortError', message: 'x' })).toBeNull()
    expect(buildChatStreamErrorReport(new TypeError('Failed to fetch'), { userInitiatedStop: true })).toBeNull()
  })

  test('returns null for expected business states (usage/rate limit)', () => {
    expect(
      buildChatStreamErrorReport(
        new Error('Usage limit reached. Enable usage-based pricing, upgrade your plan, or check your AI provider settings.'),
        { projectId: 'proj-1', sessionId: 'sess-1' },
      ),
    ).toBeNull()
    expect(buildChatStreamErrorReport(new Error('{"error":{"code":"usage_limit_reached"}}'))).toBeNull()
  })

  test('builds a tagged, fingerprinted report for a connection failure', () => {
    const report = buildChatStreamErrorReport(new TypeError('Failed to fetch'), {
      turnId: 'turn-1',
      sessionId: 'sess-1',
      projectId: 'proj-1',
      lastSeq: 42,
    })
    expect(report).not.toBeNull()
    expect(report!.class).toBe('connection')
    expect(report!.level).toBe('error')
    expect(report!.message).toBe('chat_stream_error: connection')
    expect(report!.fingerprint).toEqual(['chat_stream_error', 'connection'])
    // Marker tag is what keeps this out of the production_web noise filter.
    expect(report!.tags[SHOGO_TELEMETRY_TAG]).toBe('chat_stream_error')
    expect(report!.tags.chatErrorClass).toBe('connection')
    expect(report!.tags.turnId).toBe('turn-1')
    expect(report!.tags.chatSessionId).toBe('sess-1')
    expect(report!.extra.rawMessage).toBe('Failed to fetch')
    expect(report!.extra.lastSeq).toBe(42)
  })

  test('a recovered turn is reported at warning level', () => {
    const report = buildChatStreamErrorReport(new TypeError('network error'), { recovered: true })
    expect(report!.level).toBe('warning')
    expect(report!.tags.recovered).toBe('true')
  })

  test('missing context degrades to "(none)" tags, never throws', () => {
    const report = buildChatStreamErrorReport(new Error('weird'))
    expect(report!.class).toBe('other')
    expect(report!.tags.projectId).toBe('(none)')
    expect(report!.tags.turnId).toBe('(none)')
  })
})
