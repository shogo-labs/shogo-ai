// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { shouldStartMeetingMonitor } from '../meeting-config'

describe('meeting monitor configuration', () => {
  test('does not start when meetings are disabled', () => {
    expect(shouldStartMeetingMonitor({ enabled: false, autoDetect: true })).toBe(false)
  })

  test('starts when meetings and auto-detection are enabled', () => {
    expect(shouldStartMeetingMonitor({ enabled: true, autoDetect: true })).toBe(true)
  })

  test('does not start when auto-detection is disabled', () => {
    expect(shouldStartMeetingMonitor({ enabled: true, autoDetect: false })).toBe(false)
  })
})
