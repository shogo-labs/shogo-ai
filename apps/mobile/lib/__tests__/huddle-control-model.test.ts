// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The floating huddle bar and the in-huddle bar read their labels, tones and
 * glyphs from one model, so a state that looks one way in the tab cannot look
 * different once the huddle is floating.
 *
 * Run: bun --no-env-file test lib/__tests__/huddle-control-model.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { cameraControl, handControl, leaveControl, micControl, quickReactionControl, reactionControl } from '../huddle-control-model'
import { PIP_ICONS } from '../huddle-pip-icons'

describe('huddle control model', () => {
  test('a muted mic keeps a neutral circle and reddens only the glyph', () => {
    expect(micControl(true)).toEqual({ label: 'Unmute', tone: 'muted', icon: 'micOff', glyph: 'destructive' })
  })

  test('an open mic is a neutral circle with a foreground glyph', () => {
    expect(micControl(false)).toEqual({ label: 'Mute', tone: 'muted', icon: 'mic', glyph: 'foreground' })
  })

  test('every active control uses the same accent, not a per-control colour', () => {
    expect(cameraControl(true).tone).toBe('accent')
    expect(handControl(true).tone).toBe('accent')
    expect(reactionControl(true).tone).toBe('accent')
  })

  test('a raised hand is the accent, not amber', () => {
    expect(handControl(true)).toMatchObject({ label: 'Lower hand', tone: 'accent', glyph: 'white', icon: 'hand' })
  })

  test('leaving is the one danger control', () => {
    expect(leaveControl()).toEqual({ label: 'Leave huddle', tone: 'danger', icon: 'phoneOff', glyph: 'white' })
    expect(micControl(true).tone).not.toBe('danger')
  })

  test('the floating bar reacts in one tap where the full bar opens a picker', () => {
    expect(quickReactionControl()).toMatchObject({ label: 'React 👍', icon: 'thumbsUp', tone: 'muted' })
    expect(reactionControl(false)).toMatchObject({ label: 'Send a reaction', icon: 'smile' })
  })

  test('every icon a control names can actually be drawn by the floating bar', () => {
    const icons = [
      micControl(true),
      micControl(false),
      cameraControl(true),
      cameraControl(false),
      reactionControl(true),
      reactionControl(false),
      quickReactionControl(),
      handControl(true),
      handControl(false),
      leaveControl(),
    ].map((c) => c.icon)

    for (const icon of icons) expect(Object.keys(PIP_ICONS)).toContain(icon)
  })
})
