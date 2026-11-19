// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the transcript does when its content height changes.
 *
 * The first layout of a resumed chat is the whole turn window mounting at
 * once. Treating it as ordinary growth animated the view down through every
 * intermediate height — the "pulled down several times" jump (SHO-407).
 */

import { describe, expect, test } from 'bun:test'
import { AUTOSCROLL_MIN_DELTA_PX, decideContentSizeChange } from '../chat-scroll-follow'

const base = {
  initialLayoutSettled: true,
  isLoadingOlder: false,
  isNative: true,
  stickToBottom: true,
  previousHeight: 1000,
  nextHeight: 1000,
}

describe('decideContentSizeChange', () => {
  test('the first layout of a session lands at the bottom, unanimated', () => {
    expect(
      decideContentSizeChange({ ...base, initialLayoutSettled: false, previousHeight: 0, nextHeight: 4000 }),
    ).toEqual({ kind: 'settle-initial-layout', scrollToEnd: true })
  })

  test('the first layout settles even when nothing has been laid out yet', () => {
    expect(
      decideContentSizeChange({ ...base, initialLayoutSettled: false, previousHeight: 0, nextHeight: 0 }),
    ).toEqual({ kind: 'settle-initial-layout', scrollToEnd: true })
  })

  test('real growth while following queues the throttled scroll', () => {
    expect(
      decideContentSizeChange({ ...base, nextHeight: 1000 + AUTOSCROLL_MIN_DELTA_PX }),
    ).toEqual({ kind: 'follow-growth' })
  })

  test('an image that resized by a few pixels does not scroll', () => {
    expect(decideContentSizeChange({ ...base, nextHeight: 1002 })).toEqual({ kind: 'none' })
  })

  test('a contraction (a widget closing) does not scroll', () => {
    expect(decideContentSizeChange({ ...base, nextHeight: 600 })).toEqual({ kind: 'none' })
  })

  test('growth does not follow once the reader has scrolled away', () => {
    expect(
      decideContentSizeChange({ ...base, stickToBottom: false, nextHeight: 2000 }),
    ).toEqual({ kind: 'none' })
  })

  test('web does not follow through this path', () => {
    expect(
      decideContentSizeChange({ ...base, isNative: false, nextHeight: 2000 }),
    ).toEqual({ kind: 'none' })
  })

  test('a load-earlier page anchors the reader by the content delta', () => {
    expect(
      decideContentSizeChange({ ...base, isLoadingOlder: true, nextHeight: 1600 }),
    ).toEqual({ kind: 'anchor-load-older', delta: 600 })
  })

  test('a load-earlier page that shrank does not anchor', () => {
    expect(
      decideContentSizeChange({ ...base, isLoadingOlder: true, nextHeight: 900 }),
    ).toEqual({ kind: 'none' })
  })

  test('a load-earlier page before any layout does not anchor', () => {
    expect(
      decideContentSizeChange({
        ...base,
        isLoadingOlder: true,
        previousHeight: 0,
        nextHeight: 600,
      }),
    ).toEqual({ kind: 'none' })
  })
})
