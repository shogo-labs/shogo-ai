// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { pickDesktopMeetingFields, shouldStartMeetingMonitor } from '../meeting-config'

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

describe('pickDesktopMeetingFields', () => {
  test('never mirrors the API-owned transcription settings', () => {
    const picked = pickDesktopMeetingFields({
      enabled: true,
      autoDetect: true,
      autoRecord: false,
      autoRecordConfirmCount: 2,
      gracePeriodSeconds: 10,
      autoStopSeconds: 60,
      whisperModel: 'base.en',
      useCloudTranscription: false,
    })
    expect(picked).toEqual({
      enabled: true,
      autoDetect: true,
      autoRecord: false,
      autoRecordConfirmCount: 2,
      gracePeriodSeconds: 10,
      autoStopSeconds: 60,
    })
  })

  test('keeps a partial patch partial', () => {
    expect(pickDesktopMeetingFields({ autoRecord: true, whisperModel: 'small.en' })).toEqual({ autoRecord: true })
    expect(pickDesktopMeetingFields({ whisperModel: 'small.en' })).toEqual({})
  })
})
