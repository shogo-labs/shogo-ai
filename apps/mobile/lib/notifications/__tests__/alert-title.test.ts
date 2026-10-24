// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { alertReasonLabel, alertTagFor, alertTitleFor } from '../alert-title'
import {
  DEFAULT_DEVICE_ALERT_PREFS,
  readDeviceAlertPrefs,
  writeDeviceAlertPrefs,
} from '../device-alert-prefs'

describe('alert-title', () => {
  test('labels the reasons that have a label', () => {
    expect(alertReasonLabel('dm')).toBe('Direct message')
    expect(alertReasonLabel('mention')).toBe('Mentioned you')
    expect(alertReasonLabel('broadcast')).toBe('Mentioned you')
    expect(alertReasonLabel('thread')).toBe('Thread reply')
    expect(alertReasonLabel('keyword')).toBeNull()
    expect(alertReasonLabel(undefined)).toBeNull()
  })

  test('prefixes the title with its label, and leaves an unlabelled title alone', () => {
    expect(alertTitleFor('dm', 'ada')).toBe('Direct message · ada')
    expect(alertTitleFor('keyword', 'ada in #general')).toBe('ada in #general')
    expect(alertTitleFor(undefined, 'ada')).toBe('ada')
  })

  test('replies in one thread share a tag; other messages share a tag per conversation', () => {
    expect(alertTagFor({ conversationId: 'c1', threadRootId: 'r1' })).toBe('thread:r1')
    expect(alertTagFor({ conversationId: 'c1', threadRootId: null })).toBe('channel:c1')
  })
})

describe('device alert prefs', () => {
  test('defaults to one dock bounce and a taskbar flash when nothing is stored', () => {
    expect(readDeviceAlertPrefs()).toEqual(DEFAULT_DEVICE_ALERT_PREFS)
  })

  test('writes a patch on top of the stored values', () => {
    const next = writeDeviceAlertPrefs({ dockBounce: 'until-focused' })
    expect(next).toEqual({ dockBounce: 'until-focused', flashTaskbar: true })
    expect(readDeviceAlertPrefs()).toEqual(next)
    writeDeviceAlertPrefs({ dockBounce: 'once', flashTaskbar: true })
  })
})
