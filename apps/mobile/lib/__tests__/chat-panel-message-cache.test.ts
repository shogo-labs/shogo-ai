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
  writeSessionFeedbackCache,
  writeSessionMessageCache,
} from '../chat-panel-message-cache'

beforeEach(() => {
  clearChatPanelMessageCache()
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
