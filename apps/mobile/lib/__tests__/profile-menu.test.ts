// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { expiryFrom } from '../team-chat-state'
import { PAUSE_OPTIONS, pauseState } from '../profile-menu'

const NOW = new Date(2026, 9, 1, 15, 0, 0)

describe('pauseState', () => {
  test('not paused without a time, with a past time, or with garbage', () => {
    expect(pauseState(null, NOW)).toEqual({ paused: false, until: null })
    expect(pauseState(undefined, NOW)).toEqual({ paused: false, until: null })
    expect(pauseState(new Date(2026, 9, 1, 14, 0).toISOString(), NOW).paused).toBe(false)
    expect(pauseState('not a date', NOW).paused).toBe(false)
  })

  test('paused later today reads as a time of day', () => {
    const state = pauseState(new Date(2026, 9, 1, 17, 30).toISOString(), NOW)
    expect(state.paused).toBe(true)
    expect(state.until).toMatch(/^Until .*5:30/)
  })

  test('paused until another day names the day', () => {
    const state = pauseState(new Date(2026, 9, 2, 9, 0).toISOString(), NOW)
    expect(state.paused).toBe(true)
    expect(state.until).toMatch(/^Until \w+/)
    expect(state.until).not.toBe('Until 9:00 AM')
  })
})

describe('PAUSE_OPTIONS', () => {
  test('every option produces a future time', () => {
    for (const option of PAUSE_OPTIONS) {
      const at = expiryFrom(option.value, NOW)
      expect(at).not.toBeNull()
      expect(new Date(at!).getTime()).toBeGreaterThan(NOW.getTime())
    }
  })
})
