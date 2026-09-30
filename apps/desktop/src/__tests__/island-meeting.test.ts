// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { MEETING_PROMPT_TTL_MS, hasMeetingActivity, reduceMeetingState } from '../island-meeting'
import { EMPTY_ISLAND_MEETING_STATE, parseIslandAction, type IslandMeetingState } from '../island-protocol'

const detected = (now = 1_000): IslandMeetingState =>
  reduceMeetingState(EMPTY_ISLAND_MEETING_STATE, { type: 'detected', app: 'Zoom', now, suggestAutoRecord: false })

describe('reduceMeetingState', () => {
  test('a detected meeting becomes a prompt', () => {
    const state = detected()
    expect(state.prompt).toEqual({ id: 'meeting-1000', app: 'Zoom', detectedAt: 1_000, suggestAutoRecord: false })
    expect(hasMeetingActivity(state)).toBe(true)
  })

  test('recording replaces the prompt and keeps the app name', () => {
    const busy = reduceMeetingState(detected(), { type: 'busy' })
    expect(busy.busy).toBe(true)
    const recording = reduceMeetingState(busy, { type: 'recording-started', id: 'rec-1', now: 2_000 })
    expect(recording).toEqual({ recording: { id: 'rec-1', startedAt: 2_000, app: 'Zoom' } })
    expect(reduceMeetingState(recording, { type: 'recording-started', id: 'rec-1', now: 3_000 })).toBe(recording)
    expect(reduceMeetingState(recording, { type: 'recording-stopped' })).toEqual({})
  })

  test('no prompt while already recording', () => {
    const recording = reduceMeetingState(EMPTY_ISLAND_MEETING_STATE, { type: 'recording-started', id: 'rec-1', now: 1 })
    expect(
      reduceMeetingState(recording, { type: 'detected', app: 'Teams', now: 2, suggestAutoRecord: false }),
    ).toBe(recording)
  })

  test('the prompt clears when that app closes or the prompt expires', () => {
    expect(reduceMeetingState(detected(), { type: 'ended', app: 'Teams' }).prompt).toBeDefined()
    expect(reduceMeetingState(detected(), { type: 'ended', app: 'Zoom' })).toEqual({})
    expect(reduceMeetingState(detected(), { type: 'expired', now: 1_000 + MEETING_PROMPT_TTL_MS - 1 }).prompt)
      .toBeDefined()
    expect(reduceMeetingState(detected(), { type: 'expired', now: 1_000 + MEETING_PROMPT_TTL_MS })).toEqual({})
  })

  test('a failure keeps the prompt so the user can retry, and dismiss clears both', () => {
    const failed = reduceMeetingState(reduceMeetingState(detected(), { type: 'busy' }), {
      type: 'failed',
      error: 'Open a Shogo window to record meetings',
    })
    expect(failed.busy).toBeUndefined()
    expect(failed.prompt?.app).toBe('Zoom')
    expect(failed.error).toContain('Open a Shogo window')
    expect(reduceMeetingState(failed, { type: 'dismissed' })).toEqual({})
  })
})

describe('parseIslandAction meeting', () => {
  test('accepts known decisions only', () => {
    expect(parseIslandAction({ type: 'meeting', decision: 'record', promptId: 'meeting-1' })).toEqual({
      type: 'meeting',
      decision: 'record',
      promptId: 'meeting-1',
    })
    expect(parseIslandAction({ type: 'meeting', decision: 'stop' })).toEqual({ type: 'meeting', decision: 'stop' })
    expect(parseIslandAction({ type: 'meeting', decision: 'delete-everything' })).toBeNull()
  })
})
