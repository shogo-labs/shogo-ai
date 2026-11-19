// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The per-session in-memory caches behind `ChatPanel` (SHO-260). Re-entering a
 * chat must paint its transcript and its thumbs without a round-trip, and
 * sign-out must drop both.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearChatPanelMessageCache,
  patchSessionFeedbackCache,
  readSessionFeedbackCache,
  readSessionMessageCache,
  sessionMessageCacheUsage,
  setSessionMessageCacheLimits,
  writeSessionFeedbackCache,
  writeSessionMessageCache,
} from '../chat-panel-message-cache'

beforeEach(() => {
  clearChatPanelMessageCache()
  setSessionMessageCacheLimits(null)
})

describe('chat panel message cache', () => {
  test('a transcript written for one session is not readable from another', () => {
    const messages = [{ id: 'm1', role: 'user', content: 'hi' }]
    writeSessionMessageCache('s1', messages)
    expect(readSessionMessageCache('s1')).toBe(messages)
    expect(readSessionMessageCache('s2')).toBeUndefined()
  })

  test('feedback round-trips per session', () => {
    writeSessionFeedbackCache('s1', { m1: 'up' })
    expect(readSessionFeedbackCache('s1')).toEqual({ m1: 'up' })
    expect(readSessionFeedbackCache('s2')).toBeUndefined()
  })

  test('an optimistic thumbs change is mirrored without dropping the rest', () => {
    writeSessionFeedbackCache('s1', { m1: 'up', m2: 'down' })
    patchSessionFeedbackCache('s1', 'm2', 'up')
    expect(readSessionFeedbackCache('s1')).toEqual({ m1: 'up', m2: 'up' })
    patchSessionFeedbackCache('s1', 'm1', null)
    expect(readSessionFeedbackCache('s1')).toEqual({ m2: 'up' })
  })

  test('patching a session with nothing cached is a no-op, so the next visit fetches', () => {
    patchSessionFeedbackCache('s1', 'm1', 'up')
    expect(readSessionFeedbackCache('s1')).toBeUndefined()
  })

  test('sign-out clears transcripts and thumbs', () => {
    writeSessionMessageCache('s1', [{ id: 'm1' }])
    writeSessionFeedbackCache('s1', { m1: 'up' })
    clearChatPanelMessageCache()
    expect(readSessionMessageCache('s1')).toBeUndefined()
    expect(readSessionFeedbackCache('s1')).toBeUndefined()
  })
})

describe('the in-memory cache is bounded (SHO-434)', () => {
  const transcript = (count: number, text = 'x') =>
    Array.from({ length: count }, (_, i) => ({ id: `m${i}`, role: 'user', content: text }))

  test('the oldest session is dropped once the count cap is reached', () => {
    setSessionMessageCacheLimits({ sessions: 2, bytes: 1024 * 1024 })
    writeSessionMessageCache('s1', transcript(1, 'first'))
    writeSessionMessageCache('s2', transcript(1, 'second'))
    writeSessionMessageCache('s3', transcript(1, 'third'))

    // The two newest survive; opening the oldest chat just fetches it again.
    expect(readSessionMessageCache('s1')).toBeUndefined()
    expect(readSessionMessageCache('s2')).toBeDefined()
    expect(readSessionMessageCache('s3')).toBeDefined()
  })

  test('reading a session makes it the newest, so the LRU is by use', () => {
    setSessionMessageCacheLimits({ sessions: 2, bytes: 1024 * 1024 })
    writeSessionMessageCache('s1', transcript(1, 'first'))
    writeSessionMessageCache('s2', transcript(1, 'second'))
    // A visit to s1 is what keeps it; s2 is now the stale one.
    expect(readSessionMessageCache('s1')).toBeDefined()
    writeSessionMessageCache('s3', transcript(1, 'third'))

    expect(readSessionMessageCache('s1')).toBeDefined()
    expect(readSessionMessageCache('s2')).toBeUndefined()
    expect(readSessionMessageCache('s3')).toBeDefined()
  })

  test('photo-heavy transcripts are evicted on bytes, not on message count', () => {
    setSessionMessageCacheLimits({ sessions: 10, bytes: 64 * 1024 })
    // Each transcript is one message holding a 32 KB image part: three of them
    // blow the 64 KB budget even though the session count is nowhere near its
    // cap, which is exactly the shape that used to fill the heap.
    const image = (seed: string) => [
      {
        id: seed,
        role: 'user',
        parts: [{ type: 'file', mediaType: 'image/jpeg', url: `data:image/jpeg;base64,${'A'.repeat(32 * 1024)}` }],
      },
    ]

    writeSessionMessageCache('s1', image('one'))
    writeSessionMessageCache('s2', image('two'))
    writeSessionMessageCache('s3', image('three'))

    expect(sessionMessageCacheUsage().sessions).toBeLessThan(3)
    expect(sessionMessageCacheUsage().bytes).toBeLessThanOrEqual(64 * 1024)
    expect(readSessionMessageCache('s3')).toBeDefined()
  })

  test('the session just written always survives, even alone over budget', () => {
    setSessionMessageCacheLimits({ sessions: 4, bytes: 1024 })
    writeSessionMessageCache('big', [
      { id: 'm1', role: 'user', content: 'B'.repeat(8 * 1024) },
    ])

    // The panel is painting from it; dropping it would only earn a re-download.
    expect(readSessionMessageCache('big')).toBeDefined()
  })
})
