// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the pure gating logic behind the "notify on turn complete" hook.
 *
 * The React hook itself is a thin shell around `shouldAttemptNotification` +
 * three async calls (`isUserInactive`, `ensureNotificationPermission`,
 * `notifyChatFinished`). We lock the synchronous decision surface here so
 * regressions (e.g. notifying during streaming, or missing the abort gate)
 * fail loudly.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/useNotifyOnTurnComplete.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  cleanPreview,
  shouldAttemptNotification,
  type ShouldAttemptArgs,
} from '../useNotifyOnTurnComplete'

function base(overrides: Partial<ShouldAttemptArgs> = {}): ShouldAttemptArgs {
  return {
    prevStreaming: true,
    nextStreaming: false,
    isActiveTab: false,
    wasAborted: false,
    sessionId: 'sess-1',
    projectId: 'proj-1',
    preferenceEnabled: true,
    ...overrides,
  }
}

describe('shouldAttemptNotification', () => {
  test('fires on the streaming true -> false falling edge', () => {
    expect(shouldAttemptNotification(base())).toBe(true)
  })

  test('does not fire while streaming is steady true', () => {
    expect(
      shouldAttemptNotification(base({ prevStreaming: true, nextStreaming: true })),
    ).toBe(false)
  })

  test('does not fire while streaming is steady false (no edge)', () => {
    expect(
      shouldAttemptNotification(base({ prevStreaming: false, nextStreaming: false })),
    ).toBe(false)
  })

  test('does not fire on the false -> true edge (turn starting)', () => {
    expect(
      shouldAttemptNotification(base({ prevStreaming: false, nextStreaming: true })),
    ).toBe(false)
  })

  test('suppressed when the turn was aborted by the user', () => {
    expect(shouldAttemptNotification(base({ wasAborted: true }))).toBe(false)
  })

  test('suppressed when the current chat tab is active/visible', () => {
    expect(shouldAttemptNotification(base({ isActiveTab: true }))).toBe(false)
  })

  test('suppressed when the user preference is disabled', () => {
    expect(shouldAttemptNotification(base({ preferenceEnabled: false }))).toBe(false)
  })

  test('suppressed when sessionId is missing', () => {
    expect(shouldAttemptNotification(base({ sessionId: null }))).toBe(false)
    expect(shouldAttemptNotification(base({ sessionId: undefined }))).toBe(false)
    expect(shouldAttemptNotification(base({ sessionId: '' }))).toBe(false)
  })

  test('suppressed when projectId is missing', () => {
    expect(shouldAttemptNotification(base({ projectId: null }))).toBe(false)
    expect(shouldAttemptNotification(base({ projectId: undefined }))).toBe(false)
    expect(shouldAttemptNotification(base({ projectId: '' }))).toBe(false)
  })
})

describe('cleanPreview', () => {
  test('passes short plain text through unchanged', () => {
    expect(cleanPreview('Hello there!')).toBe('Hello there!')
  })

  test('collapses runs of whitespace into single spaces', () => {
    expect(cleanPreview('one   two\n\nthree\ttwo')).toBe('one two three two')
  })

  test('strips fenced code blocks', () => {
    const input = 'Before\n```ts\nconst x = 1\n```\nafter'
    const cleaned = cleanPreview(input)
    expect(cleaned).toBe('Before after')
  })

  test('strips inline backtick spans', () => {
    expect(cleanPreview('Use `const x = 1` please')).toBe('Use please')
  })

  test('truncates long text with an ellipsis', () => {
    const long = 'a'.repeat(200)
    const out = cleanPreview(long)
    expect(out.length).toBeLessThanOrEqual(140)
    expect(out.endsWith('…')).toBe(true)
  })

  test('does not append ellipsis when the text fits', () => {
    const ok = 'a'.repeat(140)
    expect(cleanPreview(ok)).toBe(ok)
  })

  test('returns empty string for empty input', () => {
    expect(cleanPreview('')).toBe('')
  })
})
