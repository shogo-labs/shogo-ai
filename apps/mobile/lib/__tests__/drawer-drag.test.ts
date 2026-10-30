// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  drawerProgressFromDelta,
  drawerReleaseVelocity,
  drawerSettleTarget,
  shouldCaptureCloseSwipe,
  shouldCaptureOpenSwipe,
} from '../drawer-drag'

const width = 300

describe('drawerProgressFromDelta', () => {
  test('follows the finger 1:1', () => {
    expect(drawerProgressFromDelta(0, 0, width)).toBe(0)
    expect(drawerProgressFromDelta(0, 75, width)).toBe(0.25)
    expect(drawerProgressFromDelta(0, 150, width)).toBe(0.5)
    expect(drawerProgressFromDelta(1, -150, width)).toBe(0.5)
  })

  test('holds at the closed and open ends', () => {
    expect(drawerProgressFromDelta(0, -40, width)).toBe(0)
    expect(drawerProgressFromDelta(0, 900, width)).toBe(1)
    expect(drawerProgressFromDelta(1, 60, width)).toBe(1)
    expect(drawerProgressFromDelta(1, -900, width)).toBe(0)
  })

  test('resumes from where an interrupted animation was', () => {
    expect(drawerProgressFromDelta(0.4, 30, width)).toBeCloseTo(0.5, 5)
  })
})

describe('capture rules', () => {
  test('open needs a clearly horizontal right swipe', () => {
    expect(shouldCaptureOpenSwipe(12, 2)).toBe(true)
    expect(shouldCaptureOpenSwipe(8, 0)).toBe(false)
    expect(shouldCaptureOpenSwipe(12, 14)).toBe(false)
    expect(shouldCaptureOpenSwipe(-20, 0)).toBe(false)
  })

  test('close needs a clearly horizontal left swipe', () => {
    expect(shouldCaptureCloseSwipe(-12, 2)).toBe(true)
    expect(shouldCaptureCloseSwipe(-8, 0)).toBe(false)
    expect(shouldCaptureCloseSwipe(-12, 14)).toBe(false)
    expect(shouldCaptureCloseSwipe(20, 0)).toBe(false)
  })
})

describe('release', () => {
  test('converts px/ms to progress per second', () => {
    expect(drawerReleaseVelocity(0.3, width)).toBeCloseTo(1, 5)
    expect(drawerReleaseVelocity(-0.3, width)).toBeCloseTo(-1, 5)
    expect(drawerReleaseVelocity(100, width)).toBe(20)
  })

  test('a slow drag settles to the nearer end', () => {
    expect(drawerSettleTarget(0.2, 0, width)).toBe(0)
    expect(drawerSettleTarget(0.6, 0, width)).toBe(1)
  })

  test('a flick overrides distance in its own direction', () => {
    expect(drawerSettleTarget(0.15, 0.9, width)).toBe(1)
    expect(drawerSettleTarget(0.85, -0.9, width)).toBe(0)
  })

  test('a small flick against the drag does not flip a deliberate drag', () => {
    expect(drawerSettleTarget(0.9, -0.05, width)).toBe(1)
    expect(drawerSettleTarget(0.1, 0.05, width)).toBe(0)
  })
})
